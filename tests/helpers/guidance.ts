/**
 * Matchers for the guidance every error carries (src/core/hints.ts, src/api/guidance.ts): `hint`
 * (how to fix it) and `docs` (a Markdown page of datanotes.dev, with its anchor) next to `error`
 * in the JSON bodies, and `Hint:` / `Docs:` lines at the end of the text agents read.
 */

import { expect } from "vitest";

/** A docs address as the hints give it: a Markdown page of the site, with an anchor or not. */
export const DOCS_URL_RE = /^https:\/\/datanotes\.dev\/[a-z0-9/_-]+\.md(#[a-z0-9_-]+)?$/;

/** Any docs address. */
export const anyDocs = () => expect.stringMatching(DOCS_URL_RE);

/** A JSON error body: this `error`, with a hint and a docs address. */
export const guided = (error: string, extra: Record<string, unknown> = {}) => ({ error, hint: expect.any(String), docs: anyDocs(), ...extra });

/**
 * The text of an error: this message, then a `Hint:` line and a `Docs:` line, whose address is
 * followed by the call that reads the same page offline: `(offline: read_docs("examples/queries#…"))`.
 */
export const guidedTextOf = (message: string) =>
  expect.stringMatching(new RegExp(`^${escape(message)}\\nHint: [^\\n]+\\nDocs: https://datanotes\\.dev/[a-z0-9/_-]+\\.md(#[a-z0-9_-]+)? \\(offline: read_docs\\("[a-z0-9/_#-]+"\\)\\)$`));

/**
 * The same text as the MCP server sends it: its agents have the docs tools, so the `Docs:` line
 * names only the call that reads the page offline: `Docs: read_docs("examples/queries#…")`.
 */
export const offlineGuidedTextOf = (message: string) => expect.stringMatching(new RegExp(`^${escape(message)}\\nHint: [^\\n]+\\nDocs: read_docs\\("[a-z0-9/_#-]+"\\)$`));

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The message of an error's text, without its `Hint:` and `Docs:` lines. */
export function messageOfText(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith("Hint: ") && !l.startsWith("Docs: "))
    .join("\n");
}

/** The `Hint:` line of an error's text (the last one), or "". */
export function hintOfText(text: string): string {
  return text.split("\n").filter((l) => l.startsWith("Hint: ")).pop()?.slice("Hint: ".length) ?? "";
}

/**
 * The docs address of an error's text (its last `Docs:` line, without the offline form), or "".
 * A line that names only the read_docs call (the MCP server's) gives the address of that page.
 */
export function docsOfText(text: string): string {
  const docs = (text.split("\n").filter((l) => l.startsWith("Docs: ")).pop()?.slice("Docs: ".length) ?? "").replace(/ \(offline: .*\)$/, "");
  const m = /^read_docs\("([^"#]+)(#[^"]+)?"\)$/.exec(docs);
  return m ? `https://datanotes.dev/${m[1]}.md${m[2] ?? ""}` : docs;
}
