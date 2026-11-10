# json-fit

[![npm](https://img.shields.io/npm/v/json-fit)](https://www.npmjs.com/package/json-fit)
[![CI](https://github.com/missingbits/json-fit/actions/workflows/ci.yml/badge.svg)](https://github.com/missingbits/json-fit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/json-fit)](LICENSE)

**Fit any JSON into a token budget without lying to the model.**

`json-fit` shrinks large JSON (API responses, database rows, logs) before it goes into an LLM prompt or an MCP / tool result:

- **Valid JSON, every key kept.** Long strings and arrays are shortened evenly across the whole document, so the tail (`total`, `next_cursor`, `error`) survives.
- **The model sees what is missing.** In-band markers such as `"… 307 more items"` and `"… [+644 chars]"` tell the model the data is partial, so it can ask for the next page instead of answering from a fragment.
- **Exact budget.** `maxTokens` (with a built-in conservative estimate or your own tokenizer) or `maxChars`. The leftover budget is used, not wasted.
- **Protect what matters.** `keep: ['id', 'next_cursor']` is never shortened or dropped.
- **Report for your code.** `omitted` lists every path that was shortened, for logs or pagination.

Zero dependencies. ~4 kB gzipped. ESM and CommonJS, Node 22+, works in browsers and edge runtimes. A 4 MB document fits in ~30 ms.

```bash
npm i json-fit
```

```ts
import { fit } from 'json-fit';

const { json } = fit(await res.json(), { maxTokens: 2000 });
```

## Motivation

Tools give agents raw data: an issue tracker returns 300 issues, a database query returns 20,000 rows, a log endpoint returns megabytes. Putting it into the context as-is is slow and expensive, and models answer worse when the useful part is buried in noise. So every tool author writes a cut-off, usually one of these:

| approach | what goes wrong |
|---|---|
| `JSON.stringify(data).slice(0, 8000)` | invalid JSON; the end of the document (`total`, `next_cursor`) is gone |
| `data.items.slice(0, 20)` | written by hand for every tool and every response shape; one 50 kB string field still blows the budget |
| [`truncate-json`](https://www.npmjs.com/package/truncate-json) | valid JSON, but it keeps the beginning and **silently** drops everything after: whole fields and the tail disappear, and nothing in the output says so |

The last point matters most. A model can't tell a cut-off list from a complete one. It will happily report "there are 21 open issues" or "this ticket has no description" — confidently and wrongly.

`json-fit` makes the cut **visible and even**: the shape of the data stays intact, each part loses a little instead of the end losing everything, and every cut leaves a marker the model understands without any instructions.

### Same 231 kB response, 600-character budget

`truncate-json`: all `body` fields and `next_cursor` are gone, and nothing says that 291 issues are missing:

```json
{"total":312,"items":[{"id":1,"title":"Issue 1"},{"id":2,"title":"Issue 2"}, … ,{"id":20,"title":"Issue 20"},{"id":21},{}]}
```

`json-fit`: every field and the cursor survive, and the model knows exactly what was cut:

```json
{"total":312,"items":[{"id":1,"title":"Issue 1","body":"Login page hangs after the update. Login page hangs afte… [+644 chars]"}, … ,"… 307 more items"],"next_cursor":"c_8f2a"}
```

## Use cases

### MCP server tool results

```ts
import { fit } from 'json-fit';

server.registerTool('search_issues', { inputSchema: { query: z.string() } }, async ({ query }) => {
  const data = await tracker.search(query);
  const { json } = fit(data, { maxTokens: 4000, keep: ['id', 'next_cursor'] });
  return { content: [{ type: 'text', text: json }] };
});
```

The model gets a result that always fits, sees `"… 280 more items"`, and calls the tool again with `next_cursor` if it needs more.

### Tool calls with the AI SDK, OpenAI or Anthropic

```ts
const getOrders = tool({
  description: 'List recent orders',
  inputSchema: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => fit(await db.orders(customerId), { maxTokens: 1500 }).value,
});
```

`value` is the fitted result as a plain object, for SDKs that serialize tool output themselves.

### Data in a prompt (RAG, reports, support bots)

```ts
const { json, truncated } = fit(customerProfile, { maxTokens: 3000, keep: ['id', 'plan', 'status'] });
const prompt = `Customer data${truncated ? ' (shortened, markers show what was cut)' : ''}:\n${json}\n\nQuestion: ${question}`;
```

### Logs and errors

```ts
// a huge error payload in an agent's context: keep its shape, not its megabytes
const { json } = fit(errorResponse, { maxChars: 2000 });
```

### Exact token counts

The built-in `estimateTokens` is fast and errs on the safe side (it overestimates). For exact budgets, pass a real tokenizer:

```ts
import { encode } from 'gpt-tokenizer';
fit(data, { maxTokens: 8000, countTokens: (text) => encode(text).length });
```

## How it works

1. If the JSON already fits, it is returned unchanged (`truncated: false`).
2. Otherwise one set of limits applies to the whole document: max string length, max array items, max object keys, max depth. A binary search finds the loosest limits that fit, then raises them further to use the leftover budget.
3. Limits tighten in a fixed order: **long strings first**, then strings and arrays together, then object keys, and as a last resort deep containers collapse to `"[object: 12 keys]"` / `"[array: 300 items]"`.
4. If even the smallest skeleton doesn't fit, you get the smallest valid result with `size > budget`. It never throws because of the budget.

Markers are plain JSON strings, so the output stays valid JSON:

| cut | marker |
|---|---|
| long string | `"Users report that after… [+1840 chars]"` |
| array items | `[…, "… 310 more items"]` (last item) |
| object keys | `{…, "…": "38 more keys"}` |
| deep container | `"[object: 12 keys]"`, `"[array: 300 items]"` |

## API

### `fit(value, options)` → `FitResult`

Fits any JSON-serializable value. Follows `JSON.stringify` semantics (`toJSON`, `Date`, `undefined`, `NaN` → `null`), plus `bigint` → string and circular references → `"[circular]"`.

### `fitJson(text, options)` → `FitResult`

Same for a JSON string. Text that is not valid JSON is shortened as a single string.

### Options

| option | default | |
|---|---|---|
| `maxTokens` | — | budget in tokens; set exactly one of `maxTokens` / `maxChars` |
| `maxChars` | — | budget in characters of the output |
| `countTokens` | `estimateTokens` | `(text) => number`, your tokenizer |
| `keep` | `[]` | never shortened or dropped: a key name anywhere (`'id'`) or a path with `*` wildcards (`'items.*.id'`, `'items[*].id'`, `'meta.cursor'`) |
| `minItems` | `1` | arrays keep at least this many items |
| `minString` | `32` | strings are not cut below this length |
| `indent` | `0` | output indentation; compact JSON costs the fewest tokens |

### `FitResult`

| field | |
|---|---|
| `json` | the fitted JSON string |
| `value` | the same as a value (`JSON.parse(json)`) |
| `truncated` | `true` if anything was cut |
| `size` | size of `json` in budget units (tokens or characters) |
| `omitted` | `[{ path: 'items', kind: 'items', count: 307 }, { path: 'items[0].body', kind: 'chars', count: 644 }, …]`; `kind` is `chars`, `items`, `keys` or `depth` |

### `estimateTokens(text)` → `number`

The default token counter: about 3 ASCII characters per token, 1 token per non-ASCII character. It errs high, so the fitted result fits real tokenizers (OpenAI, Anthropic) with a margin.

## Limitations

- Arrays keep their **first** items. Head + tail sampling is planned.
- Limits are uniform across the document. One huge array and one small array get the same item limit.
- Bare names in `keep` (`'id'`) are not protected inside containers collapsed by the last-resort depth step. Paths (`'items.*.id'`) are.
- The input is fully parsed in memory; this is not a streaming parser.

## License

MIT
