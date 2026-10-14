/**
 * A tokenizer-free estimate of how many tokens a text costs a model: words count about one token
 * per 4 letters, numbers one per 3 digits, every other symbol (JSON punctuation, quotes, …) one.
 * Close to real tokenizers on JSON and on Italian/English prose (within ~15%); good for telling
 * which tools and sessions fill the context, not for billing.
 *
 * One pass over the text, character by character: a run of letters (`\p{L}`) or of digits
 * (`\p{N}`) is one word or number, its length counted in UTF-16 units; white space (`\s`) counts
 * nothing; any other character counts one.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  /** The current run: letters (above 0) or digits (below 0), in UTF-16 units. */
  let run = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    // a pair of surrogates is one character; a lone one is a character of its own
    const cp = c >= 0xd800 && c <= 0xdbff ? text.codePointAt(i)! : c;
    const width = cp > 0xffff ? 2 : 1;
    const kind = classOf(cp);
    if (kind === LETTER && run >= 0) run += width;
    else if (kind === DIGIT && run <= 0) run -= width;
    else {
      n += run > 0 ? Math.ceil(run / 4) : Math.ceil(-run / 3);
      run = kind === LETTER ? width : kind === DIGIT ? -width : 0;
      if (kind === OTHER) n += 1;
    }
    i += width;
  }
  return n + (run > 0 ? Math.ceil(run / 4) : Math.ceil(-run / 3));
}

const LETTER = 0;
const DIGIT = 1;
const SPACE = 2;
const OTHER = 3;

/** The class of a code point as the regular expressions `\p{L}`, `\p{N}` and `\s` (Unicode mode) say. */
function test(cp: number): number {
  const ch = String.fromCodePoint(cp);
  return /\p{L}/u.test(ch) ? LETTER : /\p{N}/u.test(ch) ? DIGIT : /\s/u.test(ch) ? SPACE : OTHER;
}

/** Each class of the Basic Multilingual Plane, once known (255: not yet). */
const BMP = new Uint8Array(0x10000).fill(255);

/** The classes of the other code points met so far (emoji, rare scripts): at most {@link ASTRAL_KEPT}. */
const ASTRAL = new Map<number, number>();
export const ASTRAL_KEPT = 4096;

function classOf(cp: number): number {
  if (cp <= 0xffff) {
    let k = BMP[cp]!;
    if (k === 255) BMP[cp] = k = test(cp);
    return k;
  }
  let k = ASTRAL.get(cp);
  if (k === undefined) {
    k = test(cp);
    if (ASTRAL.size < ASTRAL_KEPT) ASTRAL.set(cp, k);
  }
  return k;
}
