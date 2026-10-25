/**
 * The git merge driver of packs of rows (`datanotes pack-merge %O %A %B %P`): two devices that add
 * or change different rows of one pack get no conflict. The three versions of the pack are merged
 * section by section, by the rows' `id`:
 *
 * - a row changed on one side only takes that side;
 * - a row added on one side is added;
 * - a row removed on one side, and left as it was on the other, is removed;
 * - a row changed differently on the two sides is a conflict in its section only: git's markers
 *   around the two versions of the section, and an exit code other than 0.
 *
 * A file that is not a pack on both sides (or cannot be read as one) is merged as text, as git
 * would (`git merge-file`): the driver can serve every note (`*.md merge=datanotes-pack`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { parsePack, type PackSection } from "../core/pack-format";
import { splitFrontmatter } from "../core/frontmatter";
import { gitExecutable } from "./git-sync";

/** A pack's sections by id, with the text before them (its front matter and the empty line). */
function sectionsOf(text: string): { head: string; byId: Map<string, PackSection> } | null {
  let parsed;
  try {
    parsed = parsePack(text);
  } catch {
    return null;
  }
  const byId = new Map<string, PackSection>();
  for (const s of parsed.sections) byId.set(String(new Map(s.ordered).get("id")), s);
  const first = parsed.sections[0]?.start ?? text.length;
  return { head: text.slice(0, first).replace(/\n*$/, "\n"), byId };
}

/**
 * Merge three versions of a pack (`base` may be "" for a pack both sides added). Null when one of
 * `ours` and `theirs` is not a pack, when they are packs of another table or key, or when a version
 * cannot be read as a pack: merge them as text. `conflicts`: the rows changed differently on both sides.
 */
export function mergePack(base: string, ours: string, theirs: string, labels: { ours?: string; theirs?: string } = {}): { text: string; conflicts: number } | null {
  const o = sectionsOf(ours);
  const t = sectionsOf(theirs);
  if (!o || !t) return null;
  const metaOf = (text: string) => splitFrontmatter(text)?.yamlText ?? "";
  const b = base.trim() === "" ? { head: "", byId: new Map<string, PackSection>() } : sectionsOf(base);
  if (!b) return null;
  // the same table and key on both sides (the description may differ: ours wins)
  const key = (text: string) => metaOf(text).split("\n").filter((l) => /^(pack|key|table_key):/.test(l)).join("\n");
  if (key(ours) !== key(theirs)) return null;
  const merged: { heading: string; text: string }[] = [];
  let conflicts = 0;
  const ids = new Set([...o.byId.keys(), ...t.byId.keys()]);
  for (const id of ids) {
    const was = b.byId.get(id)?.text;
    const mine = o.byId.get(id);
    const other = t.byId.get(id);
    const m = mine?.text;
    const x = other?.text;
    let pick: PackSection | undefined;
    if (m === x) pick = mine;
    else if (m === was) pick = other; // changed (or removed) on their side only
    else if (x === was) pick = mine; // changed (or removed) on our side only
    else {
      conflicts++;
      // the two versions in git's markers: inside the section when both have it under one heading
      const lines = (s: string) => (s === "" ? [] : [s.replace(/\n$/, "")]);
      const inner = (s: PackSection) => s.text.slice(s.text.indexOf("\n") + 1);
      const both = mine && other && mine.heading === other.heading;
      const head = both ? [`## ${mine.heading}`] : [];
      const a = both ? inner(mine) : (m ?? "");
      const c = both ? inner(other!) : (x ?? "");
      merged.push({
        heading: (mine ?? other)!.heading,
        text: `${[...head, `<<<<<<< ${labels.ours ?? "ours"}`, ...lines(a), "=======", ...lines(c), `>>>>>>> ${labels.theirs ?? "theirs"}`].join("\n")}\n`,
      });
      continue;
    }
    if (pick) merged.push({ heading: pick.heading, text: pick.text });
  }
  merged.sort((a, c) => (a.heading < c.heading ? -1 : a.heading > c.heading ? 1 : 0));
  // as the engine writes a pack: one line break before each section
  return { text: o.head.replace(/\n+$/, "\n") + merged.map((s) => `\n${s.text}`).join(""), conflicts };
}

/**
 * `datanotes pack-merge <base> <ours> <theirs> [<path>]`, as git calls a merge driver: the result
 * is written over `<ours>`; the exit code is 0 when it merged cleanly, 1 when it left conflicts.
 */
export function packMergeMain(args: readonly string[]): number {
  const [basePath, oursPath, theirsPath, name] = args;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write("usage: datanotes pack-merge <base> <ours> <theirs> [<path>] (git's %O %A %B %P)\n");
    return 2;
  }
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  const labels = { ours: name ? `ours:${name}` : "ours", theirs: name ? `theirs:${name}` : "theirs" };
  const r = mergePack(read(basePath), read(oursPath), read(theirsPath), labels);
  if (r) {
    fs.writeFileSync(oursPath, r.text);
    if (r.conflicts > 0) process.stderr.write(`datanotes pack-merge: ${r.conflicts} row${r.conflicts === 1 ? "" : "s"} changed on both sides${name ? ` in ${name}` : ""}\n`);
    return r.conflicts > 0 ? 1 : 0;
  }
  // not a pack: a text merge, as git does it
  const out = spawnSync(gitExecutable(), ["merge-file", "-L", labels.ours, "-L", "base", "-L", labels.theirs, oursPath, basePath, theirsPath], { stdio: "inherit", windowsHide: true });
  return out.status === 0 ? 0 : 1;
}
