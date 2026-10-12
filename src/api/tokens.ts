/**
 * A tokenizer-free estimate of how many tokens a text costs a model: words count about one token
 * per 4 letters, numbers one per 3 digits, every other symbol (JSON punctuation, quotes, …) one.
 * Close to real tokenizers on JSON and on Italian/English prose (within ~15%); good for telling
 * which tools and sessions fill the context, not for billing.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu)) {
    const s = m[0];
    if (/^\p{L}/u.test(s)) n += Math.ceil(s.length / 4);
    else if (/^\p{N}/u.test(s)) n += Math.ceil(s.length / 3);
    else n += 1;
  }
  return n;
}
