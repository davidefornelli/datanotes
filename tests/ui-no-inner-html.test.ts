/**
 * The database browser injects HTML in one place only: MarkdownView.tsx, which shows what
 * src/ui/markdown/render.ts made safe (plan D7). Any other way of turning a string into markup or
 * code fails here, naming the file and the line.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI = path.resolve(__dirname, "..", "src", "ui");
const ALLOWED = path.join(UI, "markdown", "MarkdownView.tsx");

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/ },
  { name: "innerHTML", re: /\binnerHTML\b/ },
  { name: "outerHTML", re: /\bouterHTML\b/ },
  { name: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/ },
  { name: "document.write", re: /\bdocument\s*\.\s*write(ln)?\b/ },
  { name: "eval(", re: /\beval\s*\(/ },
  { name: "new Function(", re: /\bnew\s+Function\s*\(/ },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every forbidden use in `text`, as `file:line: name`. */
export function findings(file: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) {
      if (!re.test(line)) continue;
      if (name === "dangerouslySetInnerHTML" && file === ALLOWED) continue;
      found.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${name}`);
    }
  });
  return found;
}

describe("no HTML injection in the UI but MarkdownView", () => {
  it("finds none in src/ui", () => {
    const files = sources(UI);
    expect(files).toContain(ALLOWED);
    const found = files.flatMap((f) => findings(f, fs.readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  it("MarkdownView.tsx uses dangerouslySetInnerHTML exactly once, and nothing else", () => {
    const text = fs.readFileSync(ALLOWED, "utf8");
    expect(text.match(/dangerouslySetInnerHTML=/g)).toHaveLength(1);
    expect(findings(ALLOWED, text)).toEqual([]);
  });

  it("names the file and the line of each forbidden use", () => {
    const file = path.join(UI, "rows", "Grid.tsx");
    const text = [
      "ok();",
      "el.innerHTML = x;",
      "el.outerHTML = x; el.insertAdjacentHTML('beforeend', x);",
      "document.write(x);",
      "eval (x); new Function('a', x);",
      "<div dangerouslySetInnerHTML={{ __html: x }} />",
    ].join("\n");
    const rel = path.relative(process.cwd(), file);
    expect(findings(file, text)).toEqual([
      `${rel}:2: innerHTML`,
      `${rel}:3: outerHTML`,
      `${rel}:3: insertAdjacentHTML`,
      `${rel}:4: document.write`,
      `${rel}:5: eval(`,
      `${rel}:5: new Function(`,
      `${rel}:6: dangerouslySetInnerHTML`,
    ]);
    expect(findings(ALLOWED, "el.innerHTML = x;")).toEqual([`${path.relative(process.cwd(), ALLOWED)}:1: innerHTML`]);
  });
});
