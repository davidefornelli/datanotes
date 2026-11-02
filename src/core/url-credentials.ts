/**
 * Credentials inside URLs (`scheme://user:password@host/...`), kept out of what the engine answers,
 * stores and logs. Three settings (telemetryEndpoint, semanticBaseUrl, storeBackupRemote) and every
 * webhook hold an address that may carry them, and a failed request repeats its URL in its error (Node's
 * fetch: "Request cannot be constructed from a URL that includes credentials: <url>", "Failed to
 * parse URL from <url>"). Text rules: they also cover the addresses `new URL` refuses (a port over
 * 65535, `^` or `|` in the host), which the settings file and the settings route accept. The URL
 * parser settles only a `\` in the user info ({@link userinfoCut}).
 */

/**
 * A scheme of at most 32 characters, then `://`. Bounded on purpose: an unbounded scheme makes the
 * global pattern quadratic on a long run of letters (100,000 letters: 3.9 s instead of 8 ms).
 */
const SCHEME = "[A-Za-z][A-Za-z0-9+.-]{0,31}:\\/\\/";
/**
 * The user info of a URL: what follows the scheme up to an `@`. These patterns take it to the last `@`
 * before the first `/`, `?` or `#` (and, in a text, white space, a quote, a backquote or an angle
 * bracket). A `\` inside it is settled by {@link userinfoCut}.
 */
const LEADING_USERINFO = new RegExp(`^(${SCHEME})[^/?#]*@`);
/** Anywhere in a text. Global: use it only with replace. Exported for the test that keeps src/api/redact.ts in step. */
export const ANY_USERINFO = new RegExp(`(${SCHEME})[^\\s/?#'"<>\`]*@`, "g");
/** Where a URL in a text ends. */
const URL_END = /[\s'"<>`]/;
/** The schemes whose authority a `\` ends for the URL parser (WHATWG "special" schemes). */
const BACKSLASH_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

/**
 * The URL parser's answer for a URL with a `\` in its user info: true when it parses and its scheme
 * ends the authority at a `\`. Then `http://u:p@evil.invalid\@good.example/x` goes to evil.invalid,
 * and the address shown must name that host. Otherwise (it does not parse, so it never reaches a
 * host) the user info runs to the last `@`, so a raw `\` in a password stays hidden.
 */
function backslashEndsAuthority(url: string): boolean {
  try {
    return BACKSLASH_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * What replaces a match of the user info patterns (`scheme` + user info + `@`) found at `offset` of
 * `text`: the scheme alone, or, when a `\` ends the authority first, the scheme and the part of the
 * match from that authority's last `@` on (the match itself when there is none).
 */
function userinfoCut(match: string, scheme: string, offset: number, text: string): string {
  const info = match.slice(scheme.length);
  const bs = info.indexOf("\\");
  if (bs < 0) return scheme;
  const rest = text.slice(offset);
  const end = rest.search(URL_END);
  if (!backslashEndsAuthority(end < 0 ? rest : rest.slice(0, end))) return scheme;
  const at = info.lastIndexOf("@", bs);
  return at < 0 ? match : scheme + info.slice(at + 1);
}

/**
 * At the end of a text cut short (a recorded tool call's value or argument, cut with "…"): a URL whose
 * authority runs to the cut. The cut may fall inside its user info, before the `@`: then nothing marks
 * where the user info ends, so all of the authority goes, up to the "…".
 */
const CUT_AUTHORITY = new RegExp(`(${SCHEME})[^\\s/?#'"<>\`]*…$`);

/** A value without the user info of its leading `scheme://user:password@` (`https://u:p@h:431800` → `https://h:431800`); any other value as it is. */
export function stripLeadingUserinfo(value: string): string {
  return value.replace(LEADING_USERINFO, (m: string, scheme: string) => userinfoCut(m, scheme, 0, value));
}

/**
 * A text (an error message, a log line) with the user info of every `scheme://user:password@` in it
 * removed. A text cut inside a URL's authority (it ends with "…") loses that authority as well
 * (`https://u:SECR…` → `https://…`): an MCP server cuts a call's arguments at 300 characters before it
 * reports them, which may leave the start of a long password without its `@`.
 */
export function redactUrlCredentials(text: string): string {
  if (!text.includes("://")) return text;
  const uncut = text.endsWith("…") ? text.replace(CUT_AUTHORITY, (m: string, scheme: string, offset: number) => (m.includes("\\") && backslashEndsAuthority(text.slice(offset)) ? m : `${scheme}…`)) : text;
  return uncut.includes("@") ? uncut.replace(ANY_USERINFO, (m: string, scheme: string, offset: number) => userinfoCut(m, scheme, offset, uncut)) : uncut;
}

/** A copy of log attributes with {@link redactUrlCredentials} applied to every string value. */
export function redactAttributes<V>(attributes: Readonly<Record<string, V>>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = (typeof value === "string" ? redactUrlCredentials(value) : value) as V;
  return out;
}

/**
 * A JSON value (a recorded tool call's arguments or result) with {@link redactUrlCredentials} applied to
 * every string in it, at any depth. New arrays and objects; the input is not changed; keys stay as they are.
 */
export function redactUrlCredentialsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (Array.isArray(value)) return value.map(redactUrlCredentialsDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactUrlCredentialsDeep(v)]));
}

/**
 * A thrown value without URL credentials. A string is redacted. An Error whose message holds some
 * gets its message and stack rewritten in place, so it keeps its class, code and cause; when it
 * cannot be changed (frozen), a plain Error with its name and the redacted message replaces it.
 * Anything else as it is.
 */
export function redactErrorCredentials(e: unknown): unknown {
  if (typeof e === "string") return redactUrlCredentials(e);
  if (!(e instanceof Error)) return e;
  const message = redactUrlCredentials(e.message);
  if (message === e.message) return e;
  try {
    e.message = message;
    if (typeof e.stack === "string") e.stack = redactUrlCredentials(e.stack);
  } catch {
    // a frozen error: replaced below
  }
  if (e.message === message) return e;
  const copy = new Error(message);
  copy.name = e.name;
  return copy;
}
