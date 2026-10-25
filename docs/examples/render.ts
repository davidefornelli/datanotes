/** Turns the runs of the chapters into the guide pages of the docs site (pages.ts). */

import type { GuidePage } from "./pages";
import type { ChapterRun } from "./run";
import type { Example, StepResult } from "./types";

const WRITE_KEYS_WHEN_SET = ["notes_changed", "files_created", "files_moved", "files_deleted", "references_updated"];
const LIST_KEYS = ["planned_edits", "planned_creates", "planned_moves", "planned_deletes", "planned_texts", "conflicts", "violations", "failed"];

/** A write's answer without its empty fields (every write answers with the same shape). */
function compactWrite(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "dry_run" && x === false) continue;
    if (WRITE_KEYS_WHEN_SET.includes(k) && x === 0) continue;
    if (LIST_KEYS.includes(k) && Array.isArray(x) && x.length === 0) continue;
    out[k] = x;
  }
  return out;
}

const isWrite = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && "op" in v && "planned_creates" in v;

/** Compact every write answer inside `v` (a batch nests one per step). */
function compactAll(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compactAll);
  if (v && typeof v === "object") {
    const o = isWrite(v) ? compactWrite(v) : (v as Record<string, unknown>);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, compactAll(x)]));
  }
  return v;
}

/** Long lists are cut: the page shows the first items and how many more there are. */
function trim(v: unknown, max = 8): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, max).map((x) => trim(x, max));
    return v.length > max ? [...head, `… ${v.length - max} more`] : head;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, max)]));
  return v;
}

/** One line of JSON, spaced for reading: `{ "name": "title", "type": "string" }`. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (v && typeof v === "object") {
    const e = Object.entries(v);
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(v) ?? "null";
}

/** JSON with short objects and lists kept on one line (a column spec reads as one line). */
function json(v: unknown, indent = "", key = 0): string {
  const flat = inline(v);
  if (v === null || typeof v !== "object" || indent.length + key + flat.length <= 90) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + json(x, inner)).join(",\n")}\n${indent}]`;
  return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${json(x, inner, JSON.stringify(k).length + 2)}`).join(",\n")}\n${indent}}`;
}

function fence(lang: string, text: string): string {
  const ticks = text.includes("```") ? "~~~~" : "```";
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

function shown(r: StepResult): string {
  const s = r.step;
  const value = s.show ? s.show(r.value) : compactAll(r.value);
  // a note read without a show of its own: its Markdown, as it reads in the vault
  if (s.op === "read_note" && !s.show && value && typeof value === "object" && typeof (value as { content?: unknown }).content === "string") {
    return fence("markdown", (value as { content: string }).content);
  }
  if (typeof value === "string") return fence("text", value);
  return fence("json", json(trim(value)));
}

/** A vault file as it reads now; a long one shown after a call (a whole `metastore.yaml`) is folded. */
function file(f: { path: string; text: string }, fold: boolean): string {
  const text = fence(f.path.endsWith(".yaml") ? "yaml" : "markdown", f.text);
  const lines = text.split("\n").length - 2;
  if (!fold || lines <= 80) return `\`${f.path}\` now reads:\n\n${text}`;
  return `<details>\n<summary><code>${f.path}</code> now reads (${lines} lines)</summary>\n\n${text}\n\n</details>`;
}

function step(r: StepResult): string {
  const s = r.step;
  const parts: string[] = [];
  if (s.say) parts.push(s.say);
  if (s.edit) {
    parts.push(`You edit \`${s.edit.path}\` by hand, outside the engine. The note now reads:`, fence("markdown", String(r.value)));
    return parts.join("\n\n");
  }
  if (s.received) {
    parts.push("The receiver got this request:", fence("json", json(trim(r.value))));
    return parts.join("\n\n");
  }
  if (s.move) {
    parts.push(`You rename \`${s.move.from}\` to \`${s.move.to}\` by hand, outside the engine.`);
    return parts.join("\n\n");
  }
  if (s.age) {
    parts.push(`The notes in \`${s.age.folder}\` haven’t changed since ${s.age.at.slice(0, 10)}.`);
    return parts.join("\n\n");
  }
  if (!s.op) {
    // A step that only shows a file is there for the file: never folded.
    if (r.file) parts.push(file(r.file, false));
    return parts.join("\n\n");
  }
  const call = Object.keys(r.args ?? {}).length ? fence("json", json(r.args)) : "";
  parts.push(`**\`${s.op}\`**${call ? "" : " (no arguments)"}`);
  if (call) parts.push(call);
  if (!s.quiet) {
    const answer = shown(r);
    const lines = answer.split("\n").length;
    const label = r.ok ? "Answer" : "Refused";
    parts.push(lines > 45 ? `<details>\n<summary>${label} (${lines - 2} lines)</summary>\n\n${answer}\n\n</details>` : `${label}:\n\n${answer}`);
  }
  if (r.file) parts.push(file(r.file, true));
  return parts.join("\n\n");
}

/** One example as a section of its page: its heading, what it shows, then every step with the engine's answer. */
export function renderExample(ex: Example, results: StepResult[]): string {
  const lines = [`## ${ex.title}`, "", ex.say, ""];
  for (const r of results) {
    const text = step(r);
    if (text) lines.push(text, "");
  }
  if (ex.after) lines.push(ex.after, "");
  return lines.join("\n");
}

/**
 * A guide page (pages.ts) from the runs of the chapters it takes examples from: its front matter,
 * the note that it is generated, its intro, the hand-written text it includes, then its examples.
 */
export function renderPage(page: GuidePage, runs: ReadonlyMap<string, ChapterRun>, generatedNote: string, included = ""): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    "sidebar:",
    ...(page.label ? [`  label: ${JSON.stringify(page.label)}`] : []),
    `  order: ${page.order}`,
    "---",
    "",
    generatedNote,
    "",
    page.intro,
    "",
  ];
  if (included.trim()) lines.push(included.trim(), "");
  for (const [slug, title] of page.examples) {
    const run = runs.get(slug);
    const i = run ? run.chapter.examples.findIndex((e) => e.title === title) : -1;
    if (!run || i < 0) throw new Error(`docs/examples/pages.ts: ${page.path}: no example "${title}" in chapter ${slug}`);
    lines.push(renderExample(run.chapter.examples[i]!, run.results[i]!));
  }
  return lines.join("\n");
}
