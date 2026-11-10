// Scores agent answers: node bench/score.ts <out>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CAUSE_KEYWORDS, SECURITY_OPEN, TOTAL } from './data.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: score.ts <out>');
const variants = ['full', 'truncate-json', 'json-fit', 'json-fit-cursor'];
const runs = readdirSync(out).filter((d) => d.startsWith('run-')).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const line = (text: string, key: string) => new RegExp(`^\\W*${key}\\W*:?\\s*(.*)$`, 'mi').exec(text)?.[1]?.trim() ?? '';

interface Row {
  run: string; total: boolean; security: boolean; recall: number; extra: number; root: boolean;
  calls: number; bytes: number; tokens?: number; cost?: number;
}
const rows: Record<string, Row[]> = {};

const pad = (s: unknown, n: number) => String(s).padEnd(n);
console.log(`\n${pad('run', 7)}${pad('variant', 17)}${pad('total', 7)}${pad('security', 10)}${pad('found', 7)}${pad('extra', 7)}${pad('root', 6)}${pad('calls', 7)}${pad('bytes', 9)}tokens`);
for (const run of runs) {
  for (const v of variants) {
    const d = join(out, run, v);
    if (!existsSync(d)) continue;
    const answer = read(join(d, 'answer.txt'));
    const total = Number(line(answer, 'TOTAL').replace(/[^\d]/g, '')) === TOTAL;
    const ids = (line(answer, 'SECURITY_OPEN').match(/\d+/g) ?? []).map(Number);
    const found = SECURITY_OPEN.filter((id) => ids.includes(id)).length;
    const extra = ids.filter((id) => !SECURITY_OPEN.includes(id)).length;
    const rootLine = line(answer, 'ROOT_CAUSE_143').toLowerCase();
    const root = ROOT_CAUSE_KEYWORDS.some((k) => rootLine.includes(k));
    const calls = read(join(d, 'calls.log')).split('\n').filter(Boolean);
    const bytes = calls.reduce((t, l) => t + Number(/stdout=(\d+)/.exec(l)?.[1] ?? 0), 0);
    let tokens: number | undefined;
    let cost: number | undefined;
    const result = read(join(d, 'result.json'));
    if (result) {
      try {
        const r = JSON.parse(result);
        const u = r.usage ?? {};
        tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        cost = r.total_cost_usd;
      } catch {}
    }
    const row: Row = { run, total, security: found === SECURITY_OPEN.length && extra === 0, recall: found, extra, root, calls: calls.length, bytes, tokens, cost };
    (rows[v] ??= []).push(row);
    const yn = (b: boolean) => (b ? 'yes' : 'NO');
    console.log(`${pad(run, 7)}${pad(v, 17)}${pad(yn(total), 7)}${pad(yn(row.security), 10)}${pad(`${found}/${SECURITY_OPEN.length}`, 7)}${pad(extra, 7)}${pad(yn(root), 6)}${pad(row.calls, 7)}${pad(bytes, 9)}${tokens ?? '-'}`);
  }
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log('\nvariant          all-correct  total  security  root   avg calls  avg tool bytes  avg agent tokens  avg cost');
for (const v of variants) {
  const r = rows[v] ?? [];
  if (!r.length) continue;
  const n = r.length;
  const c = (f: (x: Row) => boolean) => `${r.filter(f).length}/${n}`;
  const tok = r.filter((x) => x.tokens !== undefined);
  const cost = r.filter((x) => x.cost !== undefined);
  console.log(
    `${pad(v, 17)}${pad(c((x) => x.total && x.security && x.root), 13)}${pad(c((x) => x.total), 7)}${pad(c((x) => x.security), 10)}${pad(c((x) => x.root), 7)}` +
      `${pad(avg(r.map((x) => x.calls)).toFixed(1), 11)}${pad(Math.round(avg(r.map((x) => x.bytes))), 16)}${pad(tok.length ? Math.round(avg(tok.map((x) => x.tokens!))) : '-', 18)}` +
      `${cost.length ? '$' + avg(cost.map((x) => x.cost!)).toFixed(3) : '-'}`,
  );
}
console.log(`\ndetails: ${out}/run-*/<variant>/{answer.txt,calls.log}`);
