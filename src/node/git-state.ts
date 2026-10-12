/**
 * Whether git is changing the vault right now: a pull of git sync under way, or a rebase, a merge
 * or another git command (its `index.lock`) in the repository that holds the vault. The links to
 * notes moved by hand are not repaired meanwhile (hand-moves.ts, `setRepairGate`): the files
 * git is moving would be read half done, and a repair written into a rebase would mix with it.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The git folder of the repository holding `dir`: its `.git` folder, or the folder a `.git` file
 * names (a worktree, a submodule). Null when `dir` is in no repository.
 */
export function gitDirOf(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    const dot = path.join(d, ".git");
    if (fs.existsSync(dot)) {
      if (fs.statSync(dot).isDirectory()) return dot;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"));
      if (m) return path.resolve(d, m[1]!.trim());
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The files git keeps in its folder while it changes the work tree, and what they mean. */
const IN_PROGRESS: [file: string, what: string][] = [
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["MERGE_HEAD", "a merge"],
  ["index.lock", "a git command"],
];

/**
 * Why git is changing the vault now, or null: `pulling` (git sync's pull under way), else a rebase,
 * a merge or a git command in progress in the repository whose git folder is `gitDir`.
 */
export function gitBusy(gitDir: string | null, pulling = false): string | null {
  if (pulling) return "git sync is pulling";
  if (!gitDir) return null;
  for (const [file, what] of IN_PROGRESS) if (fs.existsSync(path.join(gitDir, file))) return `${what} is in progress in the vault's git repository (${file})`;
  return null;
}
