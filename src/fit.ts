import { estimateTokens } from './tokens.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface FitOptions {
  /** Budget in tokens (measured with `countTokens`). Set exactly one of `maxTokens` / `maxChars`. */
  maxTokens?: number;
  /** Budget in characters of the output JSON string. */
  maxChars?: number;
  /** Token counter used with `maxTokens`. Default: `estimateTokens` (fast, conservative). */
  countTokens?: (text: string) => number;
  /**
   * Values that are never shortened and keys that are never dropped.
   * A bare name (`'id'`) matches that key anywhere; a path matches one location,
   * `*` matches any key or index: `'next_cursor'`, `'items.*.id'`, `'meta.request_id'`.
   */
  keep?: string[];
  /** Arrays keep at least this many items. Default 1. */
  minItems?: number;
  /** Strings are never cut below this many characters. Default 32. */
  minString?: number;
  /** Indentation of the output JSON. Default 0 (compact, fewest tokens). */
  indent?: number;
}

export interface Omission {
  /** Where data was hidden: `''` (root), `'items'`, `'items[0].body'`, `'meta["x-id"]'`. */
  path: string;
  /** `chars` – string shortened, `items` – array items, `keys` – object keys, `depth` – container collapsed. */
  kind: 'chars' | 'items' | 'keys' | 'depth';
  /** How many characters / items / keys were hidden. */
  count: number;
}

export interface FitResult {
  /** Valid JSON, within the budget whenever the budget allows it. */
  json: string;
  /** The same result as a value (`JSON.parse(json)`). */
  value: Json;
  /** `true` if anything was shortened or hidden. */
  truncated: boolean;
  /** Size of `json` in budget units (tokens for `maxTokens`, characters for `maxChars`). */
  size: number;
  /** Everything that was hidden, in document order. */
  omitted: Omission[];
}

interface Limits {
  str: number;
  items: number;
  keys: number;
  depth: number;
}

type Seg = string | number;

const MORE_KEYS = '…';
// Interleaved ladders: long strings shrink first, then strings and arrays shrink together.
const STR_STEPS = [Infinity, 2000, 1000, 500, 300, 200, 150, 100, 80, 64, 48, 32];
const ITEM_STEPS = [Infinity, Infinity, Infinity, 100, 50, 30, 20, 12, 8, 5, 3, 2, 1];
const KEY_STEPS = [20, 10, 5, 3, 2, 1];

/** Shrink any JSON-serializable value to fit a token (or character) budget. */
export function fit(value: unknown, options: FitOptions): FitResult {
  const cfg = config(options);
  const root = normalize(value, '', new Set());
  return fitNormalized(root === undefined ? null : root, cfg);
}

/** Like `fit`, for a JSON string. Invalid JSON is shortened as plain text. */
export function fitJson(text: string, options: FitOptions): FitResult {
  const cfg = config(options);
  let root: Json;
  try {
    root = JSON.parse(text) as Json;
  } catch {
    return fitString(text, cfg);
  }
  return fitNormalized(root, cfg);
}

interface Config {
  budget: number;
  measure: (json: string) => number;
  keep: Matcher;
  minItems: number;
  minString: number;
  indent: number;
}

function config(o: FitOptions): Config {
  const hasTokens = o.maxTokens !== undefined;
  const hasChars = o.maxChars !== undefined;
  if (hasTokens === hasChars) throw new TypeError('json-fit: set exactly one of `maxTokens` or `maxChars`');
  const budget = (hasTokens ? o.maxTokens : o.maxChars) as number;
  if (!(budget > 0)) throw new TypeError('json-fit: the budget must be a positive number');
  const count = o.countTokens ?? estimateTokens;
  return {
    budget,
    measure: hasTokens ? count : (json) => json.length,
    keep: matcher(o.keep ?? []),
    minItems: Math.max(1, Math.floor(o.minItems ?? 1)),
    minString: Math.max(1, Math.floor(o.minString ?? 32)),
    indent: o.indent ?? 0,
  };
}

function fitNormalized(root: Json, cfg: Config): FitResult {
  const stringify = (v: Json) => JSON.stringify(v, null, cfg.indent || undefined);
  const full = stringify(root);
  const fullSize = cfg.measure(full);
  if (fullSize <= cfg.budget) return { json: full, value: root, truncated: false, size: fullSize, omitted: [] };
  if (typeof root === 'string') return fitString(root, cfg);
  if (root === null || typeof root !== 'object') return { json: full, value: root, truncated: false, size: fullSize, omitted: [] };

  const st = stats(root);
  const levels = ladder(cfg, st.depth);
  const attempt = (limits: Limits): FitResult => {
    const r = new Renderer(limits, cfg.keep);
    const value = r.render(root, [], 0);
    const json = stringify(value);
    return { json, value, truncated: true, size: cfg.measure(json), omitted: r.omitted };
  };

  // 1. the first ladder level that fits; sizes shrink (almost) monotonically along the ladder
  let best = attempt(levels[levels.length - 1]!);
  if (best.size > cfg.budget) return best; // budget smaller than the skeleton: best effort
  let lo = 0;
  let hi = levels.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = attempt(levels[mid]!);
    if (r.size <= cfg.budget) {
      best = r;
      hi = mid;
    } else lo = mid + 1;
  }
  if (lo === 0) return best;

  // 2. use the leftover budget: raise each limit that changed since the previous level, as far as it fits
  let limits = { ...levels[lo]! };
  const prev = levels[lo - 1]!;
  for (const f of ['items', 'str', 'keys'] as const) {
    let a = limits[f];
    let b = Math.min(prev[f], st[f]);
    if (b <= a) continue;
    while (a < b) {
      const mid = Math.ceil((a + b) / 2);
      const r = attempt({ ...limits, [f]: mid });
      if (r.size <= cfg.budget) {
        best = r;
        a = mid;
      } else b = mid - 1;
    }
    limits = { ...limits, [f]: a };
  }
  return best;
}

function ladder(cfg: Config, maxDepth: number): Limits[] {
  const levels: Limits[] = [];
  const n = Math.max(STR_STEPS.length, ITEM_STEPS.length);
  for (let i = 1; i < n; i++) {
    levels.push({
      str: Math.max(cfg.minString, STR_STEPS[Math.min(i, STR_STEPS.length - 1)]!),
      items: Math.max(cfg.minItems, ITEM_STEPS[Math.min(i, ITEM_STEPS.length - 1)]!),
      keys: Infinity,
      depth: Infinity,
    });
  }
  const min = levels[levels.length - 1]!;
  for (const keys of KEY_STEPS) levels.push({ ...min, keys });
  const tight = levels[levels.length - 1]!;
  for (let depth = maxDepth - 1; depth >= 1; depth--) levels.push({ ...tight, depth });
  return levels;
}

class Renderer {
  omitted: Omission[] = [];
  private limits: Limits;
  private keep: Matcher;
  constructor(limits: Limits, keep: Matcher) {
    this.limits = limits;
    this.keep = keep;
  }

  render(node: Json, segs: Seg[], depth: number): Json {
    if (typeof node === 'string') return this.str(node, segs);
    if (node === null || typeof node !== 'object') return node;
    const L = this.limits;

    if (Array.isArray(node)) {
      if (depth >= L.depth && node.length > 0 && !this.keep.under(segs)) {
        this.omit(segs, 'depth', node.length);
        return `[array: ${node.length} items]`;
      }
      const shown = Math.min(node.length, L.items);
      const out: Json[] = [];
      for (let i = 0; i < shown; i++) out.push(this.child(node[i]!, [...segs, i], depth + 1));
      if (node.length > shown) {
        const hidden = node.length - shown;
        out.push(`… ${hidden} more items`);
        this.omit(segs, 'items', hidden);
      }
      return out;
    }

    const keys = Object.keys(node);
    const collapsed = depth >= L.depth;
    const out: { [key: string]: Json } = {};
    let shown = 0;
    let kept = 0;
    let hidden = 0;
    for (const k of keys) {
      const childSegs = [...segs, k];
      if (this.keep.has(childSegs)) {
        out[k] = node[k]!;
        kept++;
      } else if (collapsed && this.keep.under(childSegs)) {
        out[k] = this.render(node[k]!, childSegs, depth + 1); // a kept path lies deeper
        kept++;
      } else if (!collapsed && shown < L.keys) {
        out[k] = this.render(node[k]!, childSegs, depth + 1);
        shown++;
      } else hidden++;
    }
    if (collapsed && kept === 0 && keys.length > 0) {
      this.omit(segs, 'depth', keys.length);
      return `[object: ${keys.length} keys]`;
    }
    if (hidden > 0) {
      out[MORE_KEYS] = `${hidden} more keys`;
      this.omit(segs, collapsed ? 'depth' : 'keys', hidden);
    }
    return out;
  }

  private child(node: Json, segs: Seg[], depth: number): Json {
    return this.keep.has(segs) ? node : this.render(node, segs, depth);
  }

  private str(s: string, segs: Seg[]): string {
    if (s.length <= this.limits.str) return s;
    const out = cut(s, this.limits.str);
    if (out.length >= s.length) return s;
    this.omit(segs, 'chars', s.length - head(s, this.limits.str).length);
    return out;
  }

  private omit(segs: Seg[], kind: Omission['kind'], count: number) {
    this.omitted.push({ path: pathString(segs), kind, count });
  }
}

/** Root string (or invalid JSON text): binary-search the longest head that fits. */
function fitString(s: string, cfg: Config): FitResult {
  const make = (n: number): FitResult => {
    const value = n >= s.length ? s : cut(s, n);
    const json = JSON.stringify(value);
    const truncated = value !== s;
    return { json, value, truncated, size: cfg.measure(json), omitted: truncated ? [{ path: '', kind: 'chars', count: s.length - head(s, n).length }] : [] };
  };
  const whole = make(s.length);
  if (whole.size <= cfg.budget) return whole;
  let best = make(0);
  if (best.size > cfg.budget) return best;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const r = make(mid);
    if (r.size <= cfg.budget) {
      best = r;
      lo = mid;
    } else hi = mid - 1;
  }
  return best;
}

function head(s: string, n: number): string {
  let h = s.slice(0, n);
  const last = h.charCodeAt(h.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) h = h.slice(0, -1); // don't split a surrogate pair
  return h;
}

function cut(s: string, n: number): string {
  const h = head(s, n);
  return `${h}… [+${s.length - h.length} chars]`;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
function pathString(segs: Seg[]): string {
  let p = '';
  for (const s of segs) {
    if (typeof s === 'number') p += `[${s}]`;
    else if (IDENT.test(s)) p += p ? `.${s}` : s;
    else p += `[${JSON.stringify(s)}]`;
  }
  return p;
}

interface Matcher {
  /** this exact location is kept */
  has(segs: Seg[]): boolean;
  /** a kept path pattern points somewhere below this location */
  under(segs: Seg[]): boolean;
}

function matcher(patterns: string[]): Matcher {
  const names = new Set<string>();
  const paths: string[][] = [];
  for (const p of patterns) {
    if (!/[.*[]/.test(p)) {
      names.add(p);
      continue;
    }
    const segs = p
      .replace(/\[(\d*|\*)\]/g, (_, i: string) => `.${i || '*'}`)
      .split('.')
      .filter((s) => s !== '');
    paths.push(segs);
  }
  if (names.size === 0 && paths.length === 0) return { has: () => false, under: () => false };
  return {
    has(segs) {
      if (segs.length === 0) return false;
      const last = segs[segs.length - 1]!;
      if (typeof last === 'string' && names.has(last)) return true;
      return paths.some((p) => p.length === segs.length && p.every((s, i) => s === '*' || s === String(segs[i])));
    },
    under(segs) {
      return paths.some((p) => p.length > segs.length && segs.every((s, i) => p[i] === '*' || p[i] === String(s)));
    },
  };
}

/** Largest depth, array length, string length and key count in the tree. */
function stats(root: Json): Limits {
  const st: Limits = { depth: 0, items: 0, str: 0, keys: 0 };
  const walk = (node: Json): number => {
    if (typeof node === 'string') st.str = Math.max(st.str, node.length);
    if (node === null || typeof node !== 'object') return 0;
    const children = Array.isArray(node) ? node : Object.values(node);
    if (Array.isArray(node)) st.items = Math.max(st.items, node.length);
    else st.keys = Math.max(st.keys, children.length);
    let max = 0;
    for (const v of children) max = Math.max(max, walk(v));
    return max + 1;
  };
  st.depth = walk(root);
  return st;
}

/** JSON.stringify semantics (toJSON, undefined, NaN), plus bigint → string and cycles → "[circular]". */
function normalize(v: unknown, key: string, ancestors: Set<object>): Json | undefined {
  if (v !== null && (typeof v === 'object' || typeof v === 'bigint')) {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = toJSON.call(v, key);
  }
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : null;
    case 'bigint':
      return v.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (v === null) return null;
  const obj = v as object;
  if (obj instanceof String || obj instanceof Number || obj instanceof Boolean) return normalize(obj.valueOf(), key, ancestors);
  if (ancestors.has(obj)) return '[circular]';
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((x, i) => normalize(x, String(i), ancestors) ?? null);
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(obj)) {
      const x = normalize((obj as Record<string, unknown>)[k], k, ancestors);
      if (x !== undefined) out[k] = x;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}
