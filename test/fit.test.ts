import { describe, expect, it } from 'vitest';
import { estimateTokens, fit, fitJson } from '../src/index.ts';

const issues = {
  total: 300,
  items: Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    title: `Issue number ${i + 1}`,
    body: 'Users report that after the update the login page hangs. '.repeat(30),
    labels: ['bug', 'auth'],
  })),
  next_cursor: 'abc123',
};

describe('fit', () => {
  it('returns small values unchanged', () => {
    const r = fit({ a: 1, b: [1, 2] }, { maxTokens: 100 });
    expect(r).toEqual({ json: '{"a":1,"b":[1,2]}', value: { a: 1, b: [1, 2] }, truncated: false, size: estimateTokens('{"a":1,"b":[1,2]}'), omitted: [] });
  });

  it('fits a large API response, keeps every top-level key and marks what was hidden', () => {
    const full = JSON.stringify(issues);
    const r = fit(issues, { maxTokens: 2000 });
    expect(estimateTokens(full)).toBeGreaterThan(50_000);
    expect(r.truncated).toBe(true);
    expect(r.size).toBeLessThanOrEqual(2000);
    expect(JSON.parse(r.json)).toEqual(r.value);
    const v = r.value as { total: number; items: unknown[]; next_cursor: string };
    expect(v.total).toBe(300);
    expect(v.next_cursor).toBe('abc123'); // the tail of the document survives
    const marker = v.items[v.items.length - 1];
    expect(marker).toMatch(/^… \d+ more items$/);
    const shown = v.items.length - 1;
    expect(r.omitted).toContainEqual({ path: 'items', kind: 'items', count: 300 - shown });
    expect(r.omitted.some((o) => o.path === 'items[0].body' && o.kind === 'chars')).toBe(true);
    expect((v.items[0] as { body: string }).body).toMatch(/… \[\+\d+ chars\]$/);
  });

  it('shrinks strings before arrays', () => {
    const r = fit({ log: 'x'.repeat(10_000), ids: [1, 2, 3, 4, 5] }, { maxChars: 3000 });
    expect(r.value).toMatchObject({ ids: [1, 2, 3, 4, 5] });
    expect(r.json.length).toBeLessThanOrEqual(3000);
  });

  it('respects maxChars exactly', () => {
    for (const maxChars of [200, 500, 1000, 5000]) {
      const r = fit(issues, { maxChars });
      expect(r.json.length).toBeLessThanOrEqual(maxChars);
      expect(r.size).toBe(r.json.length);
    }
  });

  it('never shortens kept values or drops kept keys', () => {
    const data = { id: 'x'.repeat(500), items: [{ id: 1, name: 'y'.repeat(500) }, { id: 2 }], other: 'z'.repeat(500) };
    const r = fit(data, { maxChars: 700, keep: ['id'] });
    const v = r.value as typeof data;
    expect(v.id).toBe(data.id);
    expect(v.items[0]!.id).toBe(1);
    expect(v.other.length).toBeLessThan(500);

    const r2 = fit(issues, { maxTokens: 1500, keep: ['items.*.id', 'next_cursor'] });
    const v2 = r2.value as { items: Array<{ id: number }>; next_cursor: string };
    expect(v2.next_cursor).toBe('abc123');
    expect(v2.items.slice(0, -1).every((x) => typeof x.id === 'number')).toBe(true);
  });

  it('accepts bracket paths in keep', () => {
    const r = fit({ a: [{ s: 'q'.repeat(300) }] }, { maxChars: 100, keep: ['a[*].s'] });
    expect((r.value as { a: Array<{ s: string }> }).a[0]!.s).toHaveLength(300);
  });

  it('drops object keys with a marker when strings and arrays are not enough', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key_${i}`, i]));
    const r = fit(wide, { maxChars: 300 });
    const v = r.value as Record<string, unknown>;
    expect(r.json.length).toBeLessThanOrEqual(300);
    expect(v['…']).toMatch(/^\d+ more keys$/);
    expect(v.key_0).toBe(0);
    expect(r.omitted).toContainEqual({ path: '', kind: 'keys', count: 200 - (Object.keys(v).length - 1) });
  });

  it('collapses deep containers as a last resort', () => {
    let deep: unknown = { leaf: 'v' };
    for (let i = 0; i < 30; i++) deep = { [`level${i}`]: deep, pad: i };
    const r = fit(deep, { maxChars: 120 });
    expect(r.json.length).toBeLessThanOrEqual(120);
    expect(r.json).toMatch(/\[object: \d+ keys\]/);
    expect(r.omitted.some((o) => o.kind === 'depth')).toBe(true);
  });

  it('returns a best-effort result when the budget is below the skeleton', () => {
    const r = fit(issues, { maxChars: 10 });
    expect(r.truncated).toBe(true);
    expect(r.size).toBeGreaterThan(10);
    expect(() => JSON.parse(r.json)).not.toThrow();
  });

  it('follows JSON.stringify semantics and survives cycles', () => {
    const a: Record<string, unknown> = {
      date: new Date('2026-01-02T03:04:05.000Z'),
      u: undefined,
      f: () => 1,
      n: Number.NaN,
      big: 10n,
      arr: [undefined, () => 1],
      boxed: new String('s'),
    };
    a.self = a;
    const r = fit(a, { maxTokens: 1000 });
    expect(r.value).toEqual({ date: '2026-01-02T03:04:05.000Z', n: null, big: '10', arr: [null, null], boxed: 's', self: '[circular]' });
    expect(fit(undefined, { maxTokens: 10 }).json).toBe('null');
  });

  it('does not split surrogate pairs', () => {
    const r = fit({ s: '😀'.repeat(500) }, { maxChars: 100 });
    const s = (r.value as { s: string }).s;
    expect(s).toMatch(/^(😀)+… \[\+\d+ chars\]$/u);
  });

  it('shortens a root string', () => {
    const r = fit('a'.repeat(1000), { maxChars: 50 });
    expect(r.json.length).toBeLessThanOrEqual(50);
    expect(r.value).toMatch(/^a+… \[\+\d+ chars\]$/);
    expect(r.omitted).toEqual([{ path: '', kind: 'chars', count: 1000 - (r.value as string).indexOf('…') }]);
  });

  it('uses a custom token counter and indentation', () => {
    const words = (t: string) => t.split(/\W+/).filter(Boolean).length;
    const r = fit(issues, { maxTokens: 300, countTokens: words, indent: 2 });
    expect(words(r.json)).toBeLessThanOrEqual(300);
    expect(r.size).toBe(words(r.json));
    expect(r.json).toContain('\n  "total": 300');
  });

  it('quotes non-identifier keys in paths', () => {
    const r = fit({ 'x-list': Array.from({ length: 100 }, (_, i) => i) }, { maxChars: 60 });
    expect(r.omitted[0]!.path).toBe('["x-list"]');
  });

  it('validates the budget', () => {
    expect(() => fit({}, {})).toThrow(TypeError);
    expect(() => fit({}, { maxTokens: 1, maxChars: 1 })).toThrow(TypeError);
    expect(() => fit({}, { maxChars: 0 })).toThrow(TypeError);
  });

  it('keeps output valid and within budget on random data', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gen = (d: number): unknown => {
      const t = rnd();
      if (d > 4 || t < 0.3) return t < 0.1 ? 'w'.repeat(Math.floor(rnd() * 400)) : Math.floor(rnd() * 1000);
      if (t < 0.65) return Array.from({ length: Math.floor(rnd() * 40) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 12) }, (_, i) => [`k${i}`, gen(d + 1)]));
    };
    for (let i = 0; i < 200; i++) {
      const v = gen(0);
      const budget = 100 + Math.floor(rnd() * 2000);
      const r = fit(v, { maxChars: budget });
      expect(JSON.parse(r.json)).toEqual(r.value);
      if (r.json.length > budget) expect(fit(v, { maxChars: 1 }).json.length).toBeGreaterThan(budget * 0.5); // only when the skeleton is too big
    }
  });
});

describe('fitJson', () => {
  it('parses and fits a JSON string', () => {
    const r = fitJson(JSON.stringify(issues), { maxTokens: 1000 });
    expect(r.size).toBeLessThanOrEqual(1000);
    expect((r.value as { next_cursor: string }).next_cursor).toBe('abc123');
  });

  it('shortens invalid JSON as text', () => {
    const r = fitJson('not json '.repeat(100), { maxChars: 60 });
    expect(r.truncated).toBe(true);
    expect(r.json.length).toBeLessThanOrEqual(60);
    expect(typeof r.value).toBe('string');
  });
});

describe('estimateTokens', () => {
  it('is conservative for ASCII and counts non-ASCII per unit', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('привет')).toBe(6);
    expect(estimateTokens('')).toBe(0);
  });
});
