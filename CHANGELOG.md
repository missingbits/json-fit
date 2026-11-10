# Changelog

## 0.1.1

- Strings are now shortened to ~100 characters before any array item is hidden (more list items stay visible).
- Docs: agent benchmark vs `truncate-json` (Claude Haiku, Claude Sonnet, Codex) and the pagination recipe (point `next_cursor` at the first hidden item).

## 0.1.0

- Initial release: `fit()` and `fitJson()` shrink JSON to a token or character budget, keep valid JSON and every key,
  shorten strings and arrays evenly with in-band markers, `keep` paths, `omitted` report, `estimateTokens()`.
