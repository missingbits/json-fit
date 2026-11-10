/**
 * Fast, dependency-free, deliberately conservative token estimate.
 *
 * JSON tokenizes at roughly 3–4 ASCII characters per token with OpenAI and Anthropic tokenizers;
 * non-ASCII text (Cyrillic, CJK, emoji) is counted as one token per UTF-16 unit.
 * Overestimating is intended: a fitted result should fit the real budget.
 * Pass `countTokens` for exact counts with a real tokenizer.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other);
}
