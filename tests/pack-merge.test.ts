/** The git merge driver of packs of rows (src/node/pack-merge.ts): unit cases, then two clones of a real repository. */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { parsePack, writePack, type PackRow } from "../src/core/pack-format";
import { mergePack } from "../src/node/pack-merge";
import { datanotesCommand, GitSync, PACK_MERGE_ATTRIBUTE } from "../src/node/git-sync";

const TABLE = "main.public.feed";
const row = (h: string, minutes: number, body = ""): PackRow => ({ heading: h, ordered: [["table", TABLE], ["id", `id-${h}`], ["minutes", minutes]], body });
const pack = (...rows: PackRow[]) => writePack({ table: TABLE, key: "2026-10" }, rows);
const minutes = (text: string) => Object.fromEntries(parsePack(text).sections.map((s) => [s.heading, new Map(s.ordered).get("minutes")]));

describe("mergePack", () => {
  const base = pack(row("a", 1), row("b", 2), row("c", 3));

  it("rows added, changed or removed on one side only merge without a conflict", () => {
    const ours = pack(row("a", 10), row("b", 2), row("c", 3), row("d", 4));
    const theirs = pack(row("a", 1), row("b", 2), row("e", 5));
    const r = mergePack(base, ours, theirs)!;
    expect(r.conflicts).toBe(0);
    expect(minutes(r.text)).toEqual({ a: 10, b: 2, d: 4, e: 5 });
    expect(r.text).toBe(pack(row("a", 10), row("b", 2), row("d", 4), row("e", 5)));
  });

  it("a pack both sides added merges too", () => {
    const r = mergePack("", pack(row("a", 1)), pack(row("b", 2)))!;
    expect([r.conflicts, minutes(r.text)]).toEqual([0, { a: 1, b: 2 }]);
  });

  it("a row changed differently on both sides is a conflict in its section only", () => {
    const r = mergePack(base, pack(row("a", 10), row("b", 2), row("c", 3)), pack(row("a", 20), row("b", 2), row("c", 30)), { ours: "ours", theirs: "theirs" })!;
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("## a\n<<<<<<< ours\nid:: id-a\nminutes:: 10\n=======\nid:: id-a\nminutes:: 20\n>>>>>>> theirs\n");
    expect(r.text).toContain("## c\nid:: id-c\nminutes:: 30");
  });

  it("a row changed on one side and removed on the other is a conflict", () => {
    const r = mergePack(base, pack(row("a", 10), row("b", 2), row("c", 3)), pack(row("b", 2), row("c", 3)))!;
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("<<<<<<< ours\n## a\nid:: id-a\nminutes:: 10\n=======\n>>>>>>> theirs\n");
  });

  it("a note that is not a pack, or a pack of another key, is left to a text merge", () => {
    expect(mergePack("", "---\ntitle: x\n---\nA\n", "---\ntitle: y\n---\nB\n")).toBeNull();
    expect(mergePack(base, pack(row("a", 1)), writePack({ table: TABLE, key: "2026-11" }, [row("a", 1)]))).toBeNull();
    expect(mergePack(base, "---\npack: x\nkey: k\n---\n\n## a\nn:: 1\n", base)).toBeNull();
  });
});

describe("pack-merge as git's merge driver", () => {
  // an identity of its own: a CI runner has none, and a pull makes a merge commit
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  let bin = "";
  let tmp = "";

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-pack-merge-"));
    // the driver as the CLI runs it (dist/datanotes.cjs pack-merge): this source, bundled
    bin = path.join(tmp, "datanotes.cjs");
    buildSync({
      stdin: { contents: 'import { packMergeMain } from "./src/node/pack-merge"; process.exitCode = packMergeMain(process.argv.slice(3));', resolveDir: path.resolve(__dirname, ".."), loader: "ts" },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bin,
      logLevel: "silent",
    });
  });

  /** A bare remote and two clones, each with the driver registered as git sync registers it. */
  async function clones(): Promise<{ a: string; b: string }> {
    const root = fs.mkdtempSync(path.join(tmp, "repo-"));
    const remote = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    git(root, "clone", "-q", remote, a);
    fs.mkdirSync(path.join(a, "feed"), { recursive: true });
    fs.writeFileSync(path.join(a, "feed", "feed 2026-10.md"), pack(row("a", 1), row("b", 2)));
    fs.writeFileSync(path.join(a, "Note.md"), "one\ntwo\nthree\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "base");
    git(a, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", remote, b);
    for (const c of [a, b]) {
      const sync = new GitSync({ vault: c, packMergeCommand: datanotesCommand(process.execPath, bin), push: false });
      expect(await sync.start()).toBe(true);
      sync.stop();
      expect(fs.readFileSync(path.join(c, ".gitattributes"), "utf8")).toBe(`${PACK_MERGE_ATTRIBUTE}\n`);
      git(c, "add", ".gitattributes");
      git(c, "commit", "-qm", "attributes");
    }
    git(a, "push", "-q", "origin", "HEAD:main");
    git(b, "pull", "-q", "--no-rebase", "origin", "main");
    return { a, b };
  }

  const commit = (c: string, msg: string) => {
    git(c, "add", "-A");
    git(c, "commit", "-qm", msg);
  };

  it("two clones adding different rows to one pack: the pull merges them, no conflict", async () => {
    const { a, b } = await clones();
    fs.writeFileSync(path.join(a, "feed", "feed 2026-10.md"), pack(row("a", 1), row("b", 2), row("c", 3)));
    commit(a, "a adds c");
    git(a, "push", "-q", "origin", "HEAD:main");
    fs.writeFileSync(path.join(b, "feed", "feed 2026-10.md"), pack(row("a", 1), row("b", 20), row("d", 4)));
    commit(b, "b adds d, changes b");
    const pull = spawnSync("git", ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"], { cwd: b, encoding: "utf8", env });
    expect(pull.status, pull.stderr).toBe(0);
    expect(minutes(fs.readFileSync(path.join(b, "feed", "feed 2026-10.md"), "utf8"))).toEqual({ a: 1, b: 20, c: 3, d: 4 });
  });

  it("the same row changed on both clones: a conflict in its section only; another note merges as text", async () => {
    const { a, b } = await clones();
    fs.writeFileSync(path.join(a, "feed", "feed 2026-10.md"), pack(row("a", 10), row("b", 2), row("c", 3)));
    fs.writeFileSync(path.join(a, "Note.md"), "one changed\ntwo\nthree\n");
    commit(a, "a");
    git(a, "push", "-q", "origin", "HEAD:main");
    fs.writeFileSync(path.join(b, "feed", "feed 2026-10.md"), pack(row("a", 20), row("b", 2)));
    fs.writeFileSync(path.join(b, "Note.md"), "one\ntwo\nthree changed\n");
    commit(b, "b");
    const pull = spawnSync("git", ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"], { cwd: b, encoding: "utf8", env });
    expect(pull.status).not.toBe(0);
    const text = fs.readFileSync(path.join(b, "feed", "feed 2026-10.md"), "utf8");
    expect(text).toContain("## a\n<<<<<<< ours:feed/feed 2026-10.md\nid:: id-a\nminutes:: 20\n=======\nid:: id-a\nminutes:: 10\n>>>>>>> theirs:feed/feed 2026-10.md\n");
    expect(text).toContain("## c\nid:: id-c\nminutes:: 3\n");
    expect(fs.readFileSync(path.join(b, "Note.md"), "utf8")).toBe("one changed\ntwo\nthree changed\n");
  });
});
