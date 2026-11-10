// `issues` CLI for the agent benchmark. Every response is limited to MAX_CHARS
// the way a tool / MCP server would limit it; ISSUES_VARIANT picks the method:
//   full           no limit (control)
//   truncate-json  truncate-json (keeps the beginning, drops the rest)
//   json-fit       json-fit (shrinks evenly, leaves markers)
import truncateJson from 'truncate-json';
import { fit } from '../src/index.ts';
import { issues } from './data.ts';

const MAX_CHARS = 12_000;
const variant = process.env.ISSUES_VARIANT ?? 'full';

const HELP = `Usage: issues <command> [options]

Commands:
  list [--limit N] [--cursor C]   list issues, newest id last (limit 1-100, default 100)
  get <id>                        show one issue

Output is JSON.`;

function print(value: unknown) {
  const json = JSON.stringify(value);
  if (variant === 'truncate-json') console.log(truncateJson(json, MAX_CHARS).jsonString);
  else if (variant === 'json-fit') console.log(fit(value, { maxChars: MAX_CHARS }).json);
  else console.log(json);
}

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`option ${name} needs a value`);
  return v;
}

const [cmd, ...args] = process.argv.slice(2);
const all = issues();

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'list') {
  const limit = Number(opt(args, '--limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit must be an integer from 1 to 100');
  const cursor = opt(args, '--cursor');
  let offset = 0;
  if (cursor !== undefined) {
    const m = /^c_([0-9a-f]+)$/.exec(cursor);
    if (!m) fail('invalid cursor');
    offset = parseInt(m[1]!, 16) ^ 0x5a5a;
    if (!(offset >= 0 && offset <= all.length)) fail('invalid cursor');
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + limit < all.length ? `c_${((offset + limit) ^ 0x5a5a).toString(16)}` : null;
  print({ total: all.length, items, next_cursor: next });
} else if (cmd === 'get') {
  const id = Number(args[0]);
  const issue = all.find((i) => i.id === id);
  if (!issue) fail(`issue ${args[0]} not found`);
  print(issue);
} else {
  fail(`unknown command "${cmd}", run "issues --help"`);
}
