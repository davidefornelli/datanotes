/**
 * Which files of a folder hold a text: the tests' check that a secret stays in the one store file
 * that keeps it by design (settings.json).
 */

import fs from "node:fs";
import path from "node:path";

/** Every file under `dir`, recursively, whose bytes read as latin1 contain `needle`: paths relative to `dir`, with `/`, sorted. */
export function filesWith(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && fs.readFileSync(full).toString("latin1").includes(needle)) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
