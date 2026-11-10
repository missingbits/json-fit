# Agent benchmark

Does the way a tool shortens its JSON change what an AI agent answers?

A fake issue tracker CLI (`issues list [--limit N] [--cursor C]`, `issues get <id>`) with 300 issues. Every response is limited to 12,000 characters, the way a tool or MCP server limits its output, using one of three variants:

| variant | what the agent gets from `issues list` (page of 100 issues, ~121 kB) |
|---|---|
| `full` | everything (control: is the task solvable at all?) |
| `truncate-json` | the first 17 issues, the last one with an **empty** `labels` array, `next_cursor` dropped, no sign that anything is missing |
| `json-fit` | 51 issues with bodies shortened to ~100 chars, `"… 49 more items"`, `next_cursor` kept |

The agent (headless, only `./issues` allowed, never told about the variant) answers:

1. How many issues are there in total?
2. The ids of **all** open issues labeled `security` (7 issues spread over all three pages).
3. The root cause described in issue #143 (the last sentence of a long body).

## Run

```sh
# Node 22+, plus the agent CLI (Claude Code or Codex) logged in
sh bench/agent-bench.sh claude haiku 5
sh bench/agent-bench.sh claude sonnet 5
sh bench/agent-bench.sh codex default 5
sh bench/agent-bench.sh --summary ~/agent-bench/<folder>
```

Each run gets fresh folders; every tool call is logged to `calls.log`.
