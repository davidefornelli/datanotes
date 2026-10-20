import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import esbuild from "esbuild";
import { codeDir, fileSha256 } from "../src/api/extension-files";
import { ExtensionError, ExtensionManifestError, MANIFEST_FILE } from "../src/api/extension-manifest";
import { RECORD_COMMIT } from "../src/api/extension-record";
import {
  cachedExtension,
  checkRef,
  fetchExtension,
  inspectFolder,
  LIMITS,
  newestTag,
  parseSource,
  scanEntryImports,
  stripCredentials,
  type ExtensionSource,
} from "../src/node/extension-fetch";
import { runGit, type GitRunner } from "../src/node/git-sync";

const BOOKS = path.resolve(__dirname, "fixtures/extensions/books");
const IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

let root: string;
let src: string;
let url: string;
let emptyRepo: string;
let shas: Record<string, string> = {};

async function git(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-ext-fetch-"));
  src = path.join(root, "src");
  fs.mkdirSync(src);
  await git(["init", "-q", "-b", "main"], src);
  copyTree(path.join(BOOKS, "v0.1.0"), src);
  await git(["add", "-A"], src);
  await git([...IDENTITY, "commit", "-q", "-m", "v0.1.0"], src);
  await git(["tag", "v0.1.0"], src);
  shas.v1 = await git(["rev-parse", "HEAD"], src);
  copyTree(path.join(BOOKS, "v0.2.0"), src);
  await git(["add", "-A"], src);
  await git([...IDENTITY, "commit", "-q", "-m", "v0.2.0"], src);
  await git(["tag", "v0.2.0"], src);
  fs.appendFileSync(path.join(src, "docs", "index.md"), "\nMore.\n");
  await git(["add", "-A"], src);
  await git([...IDENTITY, "commit", "-q", "-m", "still 0.2.0"], src);
  await git(["tag", "v0.3.0"], src);
  url = pathToFileURL(src).href;
  emptyRepo = path.join(root, "empty");
  fs.mkdirSync(emptyRepo);
  await git(["init", "-q", "-b", "main"], emptyRepo);
  fs.writeFileSync(path.join(emptyRepo, "a.txt"), "a");
  await git(["add", "-A"], emptyRepo);
  await git([...IDENTITY, "commit", "-q", "-m", "a"], emptyRepo);
}, 60_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let home: string;
let work: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-ext-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-ext-work-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function problem(fn: () => unknown): ExtensionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExtensionError);
    return e as ExtensionError;
  }
  throw new Error("did not throw");
}

async function problemAsync(fn: () => Promise<unknown>): Promise<ExtensionError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExtensionError);
    return e as ExtensionError;
  }
  throw new Error("did not throw");
}

/** A copy of the v0.1.0 fixture to break in a test. */
function folder(): string {
  const f = path.join(work, "ext");
  copyTree(path.join(BOOKS, "v0.1.0"), f);
  return f;
}

describe("parseSource", () => {
  it("reads folders: existing, relative and absolute", () => {
    const abs = path.join(work, "my-ext");
    fs.mkdirSync(abs);
    const a = parseSource(abs);
    expect(a).toEqual({ kind: "local", path: abs.split("\\").join("/"), label: abs.split("\\").join("/") });
    const rel = parseSource("./my-ext", work);
    expect(rel.kind === "local" && rel.path).toBe(abs.split("\\").join("/"));
    const bare = parseSource("my-ext", work);
    expect(bare.kind).toBe("local");
    expect(parseSource(`  ${abs}  `).kind).toBe("local");
  });

  it("refuses a missing folder and an empty text", () => {
    const e = problem(() => parseSource("./nope", work));
    expect(e.message).toBe(`no folder ${path.resolve(work, "nope")}`);
    expect(e.hint).toBe("Check the path, or give a git URL.");
    expect(e.docs).toContain("administration/extensions.md#install-an-extension");
    const none = problem(() => parseSource("  "));
    expect(none.message).toBe("no source given");
    expect(none.hint).toBe("Give a git URL with #<tag>, owner/repo@<tag>, or a folder.");
    expect(problem(() => parseSource(path.join(work, "a-file-not-here.txt"))).message).toContain("no folder");
    fs.writeFileSync(path.join(work, "plain.txt"), "x");
    expect(problem(() => parseSource(path.join(work, "plain.txt"))).message).toContain("no folder");
  });

  it("reads git URLs with and without a ref", () => {
    expect(parseSource("https://example.com/team/ext.git#v1.0.0")).toEqual({
      kind: "git",
      url: "https://example.com/team/ext.git",
      ref: "v1.0.0",
      label: "https://example.com/team/ext.git#v1.0.0",
    });
    const sha = "a".repeat(40);
    expect(parseSource(`git@example.com:a/b.git#${sha}`)).toMatchObject({ kind: "git", url: "git@example.com:a/b.git", ref: sha });
    expect(parseSource("file:///tmp/repo")).toMatchObject({ kind: "git", url: "file:///tmp/repo", ref: null });
    expect(parseSource("https://example.com/x.git#")).toMatchObject({ ref: null });
  });

  it("reads GitHub shorthands", () => {
    expect(parseSource("owner/repo@v0.1.0")).toEqual({ kind: "git", url: "https://github.com/owner/repo.git", ref: "v0.1.0", label: "owner/repo@v0.1.0" });
    expect(parseSource("github:owner/repo")).toMatchObject({ url: "https://github.com/owner/repo.git", ref: null });
    expect(parseSource("owner/repo.git@1.2.3")).toMatchObject({ url: "https://github.com/owner/repo.git", ref: "1.2.3" });
  });

  it("refuses a branch, a short commit and junk, each with its message", () => {
    for (const bad of ["https://example.com/x.git#main", "owner/repo@main", `https://example.com/x.git#${"a".repeat(7)}`]) {
      const e = problem(() => parseSource(bad));
      expect(e.message).toMatch(/^ref ".+" is not a version tag or a commit$/);
      expect(e.hint).toContain("a branch moves");
    }
    const e = problem(() => parseSource("what is this"));
    expect(e.message).toBe('"what is this" is not a source');
    expect(e.hint).toContain("owner/repo@<tag> for GitHub");
    expect(e.docs).toContain("#install-an-extension");
  });

  it("checkRef accepts tags, prereleases and full commits only", () => {
    for (const ok of ["v1.2.3", "1.2.3", "v1.0.0-rc.1", "a".repeat(40)]) expect(() => checkRef(ok)).not.toThrow();
    for (const bad of ["main", "v1.2", "A".repeat(40), "a".repeat(39)]) expect(() => checkRef(bad)).toThrow(ExtensionError);
  });
});

// runs git (a fetch is five git processes): slow on Windows under load
describe("credentials in a URL (R1-6)", { timeout: 60_000 }, () => {
  it("strips a user and a password from http(s) and file URLs", () => {
    expect(stripCredentials("https://user:s3cret@example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(stripCredentials("https://TOKEN@example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(stripCredentials("https://example.com/a@b.git")).toBe("https://example.com/a@b.git");
    expect(stripCredentials("git@example.com:a/b.git")).toBe("git@example.com:a/b.git");
    expect(stripCredentials("owner/repo")).toBe("owner/repo");
  });

  it("keeps only the user name of an ssh:// URL", () => {
    expect(stripCredentials("ssh://git:pw@example.com/a/b.git")).toBe("ssh://git@example.com/a/b.git");
    expect(stripCredentials("ssh://git@example.com/a/b.git")).toBe("ssh://git@example.com/a/b.git");
  });

  it("parseSource records and labels the URL without credentials, and keeps them for git", () => {
    const s = parseSource("https://user:s3cret@example.com/team/ext.git#v1.0.0");
    expect(s).toEqual({
      kind: "git",
      url: "https://example.com/team/ext.git",
      ref: "v1.0.0",
      label: "https://example.com/team/ext.git#v1.0.0",
      cloneUrl: "https://user:s3cret@example.com/team/ext.git",
    });
    expect(JSON.stringify(s.kind === "git" ? { url: s.url, label: s.label } : {})).not.toContain("s3cret");
    expect(JSON.stringify(s.kind === "git" ? { url: s.url, label: s.label } : {})).not.toContain("user");
  });

  it("never stores or prints the credentials: record, label and errors", async () => {
    const secret = "s3cret-token";
    const withCreds = `https://bob:${secret}@example.invalid/team/ext.git`;
    const source = parseSource(`${withCreds}#v1.0.0`);
    // git echoes the address it was given, as some versions do when a connection fails; init and config run for real
    const echo: GitRunner = async (args, cwd, opts) =>
      args.includes(withCreds) ? { code: 128, stdout: "", stderr: `fatal: unable to access '${withCreds}': failed\n` } : runGit(args, cwd, opts);
    const e = await problemAsync(() => fetchExtension(source, { home, git: echo, tmpRoot: work }));
    expect(e.message).toBe("git could not fetch https://example.invalid/team/ext.git at v1.0.0: fatal: unable to access 'https://example.invalid/team/ext.git': failed");
    expect(JSON.stringify(e.message + e.hint + e.docs)).not.toContain(secret);
    const listing: GitRunner = async (args) => ({ code: 128, stdout: "", stderr: `fatal: ${args[args.length - 1]} denied` });
    const t = await problemAsync(() => newestTag(withCreds, listing));
    expect(t.message).toBe("git could not list the tags of https://example.invalid/team/ext.git: fatal: https://example.invalid/team/ext.git denied");
    // a successful fetch records the safe URL
    const local: GitRunner = async (args, cwd, opts) => runGit(args.map((a) => (a === withCreds ? url : a)), cwd, opts);
    const ok = await fetchExtension(parseSource(`${withCreds}#v0.1.0`), { home, git: local, tmpRoot: work });
    expect(ok.source).toEqual({ kind: "git", url: "https://example.invalid/team/ext.git", ref: "v0.1.0" });
    expect(ok.label).toBe("https://example.invalid/team/ext.git#v0.1.0");
    expect(JSON.stringify(ok)).not.toContain(secret);
    expect(JSON.stringify(ok)).not.toContain("bob");
  });
});

// runs git: slow on Windows under load (30 s, as tests/git-sync.test.ts)
describe("newestTag", { timeout: 30_000 }, () => {
  it("answers the tag with the highest version", async () => {
    expect(await newestTag(url)).toBe("v0.3.0");
  });

  it("ignores tags that are not versions and compares numbers, not text", async () => {
    const fake: GitRunner = async () => ({
      code: 0,
      stdout: ["a\trefs/tags/v0.9.0", "b\trefs/tags/v0.10.0", "c\trefs/tags/nightly", "d\trefs/tags/v0.10.0-rc.1", "junk line", ""].join("\n"),
      stderr: "",
    });
    expect(await newestTag("https://example.com/x.git", fake)).toBe("v0.10.0");
  });

  it("refuses a repository without version tags", async () => {
    const e = await problemAsync(() => newestTag(pathToFileURL(emptyRepo).href));
    expect(e.message).toBe(`no version tag in ${pathToFileURL(emptyRepo).href}`);
    expect(e.hint).toContain("git tag v0.1.0");
    expect(e.docs).toContain("#check-and-publish-an-extension");
  });

  it("refuses an unreachable URL with the fetch hint", async () => {
    const missing = pathToFileURL(path.join(root, "does-not-exist")).href;
    const e = await problemAsync(() => newestTag(missing));
    expect(e.message).toContain(`git could not list the tags of ${missing}: `);
    expect(e.hint).toContain("A private repository needs git's credentials");
    expect(e.docs).toContain("#install-an-extension");
    expect(e.code).toBe("fetch");
    const silent: GitRunner = async () => ({ code: 7, stdout: "", stderr: "" });
    expect((await problemAsync(() => newestTag(missing, silent))).message).toBe(`git could not list the tags of ${missing}: exit code 7`);
  });
});

// each test fetches one to three times, five git processes each (a clone was two): up to 25 s seen with the clone
describe("fetchExtension from git", { timeout: 120_000 }, () => {
  it("fetches a tag into the cache", async () => {
    const got = await fetchExtension({ kind: "git", url, ref: "v0.1.0", label: url }, { home, tmpRoot: work });
    expect(got.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(got.commit).toMatch(RECORD_COMMIT);
    expect(got.commit).toBe(shas.v1);
    expect(got.dir).toBe(codeDir(home, "books", got.commit));
    expect(got.manifest.name).toBe("books");
    expect(got.source).toEqual({ kind: "git", url, ref: "v0.1.0" });
    expect(got.label).toBe(url);
    const files: string[] = [];
    const walk = (d: string, rel: string): void => {
      for (const n of fs.readdirSync(d)) {
        const a = path.join(d, n);
        if (fs.statSync(a).isDirectory()) walk(a, `${rel}${n}/`);
        else files.push(`${rel}${n}`);
      }
    };
    walk(got.dir, "");
    expect(files.sort()).toEqual(["README.md", MANIFEST_FILE, "docs/index.md", "docs/tools.md", "lib/extension.mjs"].sort());
    expect(got.manifestSha256).toBe(fileSha256(path.join(got.dir, MANIFEST_FILE)));
    expect(got.entrySha256).toBe(fileSha256(path.join(got.dir, "lib", "extension.mjs")));
    // byte for byte what was committed: no CRLF conversion
    expect(fileSha256(path.join(got.dir, "docs", "index.md"))).toBe(fileSha256(path.join(BOOKS, "v0.1.0", "docs", "index.md")));
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
  });

  it("chooses the newest tag when no ref is given", async () => {
    const got = await fetchExtension({ kind: "git", url, ref: null, label: url }, { home, tmpRoot: work }).catch((e: ExtensionError) => e);
    // v0.3.0 holds manifest version 0.2.0
    expect((got as ExtensionError).message).toBe("the tag v0.3.0 holds version 0.2.0");
  });

  it("fetches a commit id", async () => {
    const got = await fetchExtension({ kind: "git", url, ref: shas.v1!, label: url }, { home, tmpRoot: work });
    expect(got.commit).toBe(shas.v1);
    expect(got.manifest.version).toBe("0.1.0");
    expect(got.source).toEqual({ kind: "git", url, ref: shas.v1 });
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
  });

  it("refuses a commit the repository does not have", async () => {
    const e = await problemAsync(() => fetchExtension({ kind: "git", url, ref: "f".repeat(40), label: url }, { home, tmpRoot: work }));
    expect(e.message).toContain(`git could not fetch ${url} at ${"f".repeat(40)}: `);
    expect(e.code).toBe("fetch");
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
  });

  it("refuses a tag that holds another version", async () => {
    const e = await problemAsync(() => fetchExtension({ kind: "git", url, ref: "v0.3.0", label: url }, { home, tmpRoot: work }));
    expect(e.message).toBe("the tag v0.3.0 holds version 0.2.0");
    expect(e.hint).toContain("v1.2.0");
    expect(e.docs).toContain("#check-and-publish-an-extension");
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
    expect(fs.existsSync(path.join(home, "code"))).toBe(false);
  });

  it("fetches the tag, not a branch of the same name, and peels an annotated tag (R2-Q2)", async () => {
    const twin = fs.mkdtempSync(path.join(root, "twin-"));
    await git(["init", "-q", "-b", "main"], twin);
    copyTree(path.join(BOOKS, "v0.1.0"), twin);
    await git(["add", "-A"], twin);
    await git([...IDENTITY, "commit", "-q", "-m", "tagged"], twin);
    await git([...IDENTITY, "tag", "-a", "v0.1.0", "-m", "release 0.1.0"], twin);
    const tagged = await git(["rev-parse", "HEAD"], twin);
    // one commit later, a branch named like the tag: git clone --branch v0.1.0 would check it out
    fs.appendFileSync(path.join(twin, "README.md"), "\nOnly on the branch.\n");
    await git([...IDENTITY, "commit", "-q", "-a", "-m", "branch"], twin);
    await git(["branch", "v0.1.0"], twin);
    const twinUrl = pathToFileURL(twin).href;
    const got = await fetchExtension({ kind: "git", url: twinUrl, ref: "v0.1.0", label: twinUrl }, { home, tmpRoot: work });
    expect(got.commit).toBe(tagged);
    expect(fs.readFileSync(path.join(got.dir, "README.md"), "utf8")).not.toContain("Only on the branch.");
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
  });

  it("reuses the cache, and refuses other content at the same commit", async () => {
    const source: ExtensionSource = { kind: "git", url, ref: "v0.1.0", label: url };
    const first = await fetchExtension(source, { home, tmpRoot: work });
    const again = await fetchExtension(source, { home, tmpRoot: work });
    expect(again).toEqual(first);
    expect(fs.readdirSync(path.dirname(first.dir)).filter((n) => n.includes(".partial-"))).toEqual([]);
    // another manifest at the same commit
    fs.appendFileSync(path.join(first.dir, MANIFEST_FILE), "\n");
    const e = await problemAsync(() => fetchExtension(source, { home, tmpRoot: work }));
    expect(e.message).toBe(`the code cache holds another books at ${first.commit}`);
    expect(e.hint).toBe(`Delete the folder ${first.dir} and run the command again.`);
    expect(e.docs).toContain("#where-extensions-live");
  });

  it("also refuses a changed entry at the same commit, and an unreadable cache", async () => {
    const source: ExtensionSource = { kind: "git", url, ref: "v0.1.0", label: url };
    const first = await fetchExtension(source, { home, tmpRoot: work });
    fs.appendFileSync(path.join(first.dir, "lib", "extension.mjs"), "\n// changed\n");
    expect((await problemAsync(() => fetchExtension(source, { home, tmpRoot: work }))).message).toContain("the code cache holds another books");
    fs.rmSync(path.join(first.dir, "lib"), { recursive: true });
    expect((await problemAsync(() => fetchExtension(source, { home, tmpRoot: work }))).message).toContain("the code cache holds another books");
  });

  it("reuses a copy that appeared while it was writing", async () => {
    const source: ExtensionSource = { kind: "git", url, ref: "v0.1.0", label: url };
    const first = await fetchExtension(source, { home, tmpRoot: work });
    fs.rmSync(first.dir, { recursive: true });
    const real = fs.renameSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      calls++;
      // the other installer finishes first
      real(from, to);
      throw new Error("EEXIST");
    });
    // same content at the same place: the copy that is there is reused
    const got = await fetchExtension(source, { home, tmpRoot: work });
    expect(calls).toBe(1);
    expect(got.dir).toBe(first.dir);
    expect(fs.readdirSync(path.dirname(first.dir)).filter((n) => n.includes(".partial-"))).toEqual([]);
  });

  it("removes the partial folder when the copy fails for another reason", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const source: ExtensionSource = { kind: "git", url, ref: "v0.1.0", label: url };
    await expect(fetchExtension(source, { home, tmpRoot: work })).rejects.toThrow("disk full");
    expect(fs.readdirSync(path.join(home, "code", "books"))).toEqual([]);
  });

  it("reports each git failure as a fetch error and removes the temporary clone", async () => {
    const source: ExtensionSource = { kind: "git", url, ref: "v0.1.0", label: url };
    const commitSource: ExtensionSource = { kind: "git", url, ref: shas.v1!, label: url };
    const cases: { name: string; source: ExtensionSource; fail: string; stderr: string; message: string }[] = [
      { name: "fetch of a tag", source, fail: "fetch", stderr: "a\nfatal: fetch broke\n", message: `git could not fetch ${url} at v0.1.0: fatal: fetch broke` },
      { name: "init", source: commitSource, fail: "init", stderr: "init broke", message: `git could not fetch ${url} at ${shas.v1}: init broke` },
      { name: "config", source: commitSource, fail: "config", stderr: "", message: `git could not fetch ${url} at ${shas.v1}: exit code 1` },
      { name: "fetch", source: commitSource, fail: "fetch", stderr: "fetch broke", message: `git could not fetch ${url} at ${shas.v1}: fetch broke` },
      { name: "checkout", source: commitSource, fail: "checkout", stderr: "checkout broke", message: `git could not fetch ${url} at ${shas.v1}: checkout broke` },
      { name: "rev-parse", source, fail: "rev-parse", stderr: "rev-parse broke", message: `git could not fetch ${url} at v0.1.0: rev-parse broke` },
    ];
    for (const c of cases) {
      const fake: GitRunner = async (args, cwd, opts) => {
        if (args[0] === c.fail) return { code: 1, stdout: "", stderr: c.stderr };
        return runGit(args, cwd, opts);
      };
      const e = await problemAsync(() => fetchExtension(c.source, { home, git: fake, tmpRoot: work }));
      expect(e.message, c.name).toBe(c.message);
      expect(e.hint).toContain("git ls-remote");
      expect(e.docs).toContain("#install-an-extension");
      expect(e.code).toBe("fetch");
      expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-")), c.name).toEqual([]);
    }
  });

  it("fetches under the system's temporary folder when no tmpRoot is given", async () => {
    const made = vi.spyOn(fs, "mkdtempSync");
    const broken: GitRunner = async () => ({ code: 1, stdout: "", stderr: "git broke" });
    const e = await problemAsync(() => fetchExtension({ kind: "git", url, ref: "v0.1.0", label: url }, { home, git: broken }));
    expect(e.message).toBe(`git could not fetch ${url} at v0.1.0: git broke`);
    const i = made.mock.calls.findIndex((c) => String(c[0]) === path.join(os.tmpdir(), "dn-ext-"));
    expect(i).toBeGreaterThanOrEqual(0);
    // the temporary folder is gone again
    expect(fs.existsSync(String(made.mock.results[i]!.value))).toBe(false);
  });

  it("refuses a commit that git reports under another id", async () => {
    const commitSource: ExtensionSource = { kind: "git", url, ref: shas.v1!, label: url };
    const fake: GitRunner = async (args, cwd, opts) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      return runGit(args, cwd, opts);
    };
    const e = await problemAsync(() => fetchExtension(commitSource, { home, git: fake, tmpRoot: work }));
    expect(e.message).toBe(`git could not fetch ${url} at ${shas.v1}: git gave commit ${"b".repeat(40)} for ${shas.v1}`);
  });

  it("refuses a commit id that is not 40 hex characters (a SHA-256 repository's)", async () => {
    const long = "c".repeat(64);
    const fake: GitRunner = async (args, cwd, opts) => (args[0] === "rev-parse" ? { code: 0, stdout: `${long}\n`, stderr: "" } : runGit(args, cwd, opts));
    const e = await problemAsync(() => fetchExtension({ kind: "git", url, ref: "v0.1.0", label: url }, { home, git: fake, tmpRoot: work }));
    expect(e.message).toBe(`git could not fetch ${url} at v0.1.0: git gave commit ${long} for v0.1.0`);
    expect(e.code).toBe("fetch");
    expect(fs.existsSync(path.join(home, "code"))).toBe(false);
    expect(fs.readdirSync(work).filter((n) => n.startsWith("dn-ext-"))).toEqual([]);
  });

  it("ignores a repository without a manifest", async () => {
    const e = await problemAsync(() => fetchExtension({ kind: "git", url: pathToFileURL(emptyRepo).href, ref: null, label: "empty" }, { home, tmpRoot: work }));
    expect(e.message).toContain("no version tag");
    const sha = await git(["rev-parse", "HEAD"], emptyRepo);
    const f = await problemAsync(() => fetchExtension({ kind: "git", url: pathToFileURL(emptyRepo).href, ref: sha, label: "empty" }, { home, tmpRoot: work }));
    expect(f.message).toBe(`no ${MANIFEST_FILE} in empty`);
  });
});

describe("fetchExtension from a folder", () => {
  it("gives a content commit, and changing a docs page changes it", async () => {
    const f = folder();
    const a = await fetchExtension({ kind: "local", path: f, label: f }, { home });
    expect(a.commit).toMatch(/^local-[0-9a-f]{12}$/);
    expect(a.commit).toMatch(RECORD_COMMIT);
    expect(a.source).toEqual({ kind: "local", path: f });
    expect(a.dir).toBe(codeDir(home, "books", a.commit));
    const same = await fetchExtension({ kind: "local", path: f, label: f }, { home });
    expect(same.commit).toBe(a.commit);
    fs.appendFileSync(path.join(f, "docs", "tools.md"), "\nOne more line.\n");
    const b = await fetchExtension({ kind: "local", path: f, label: f }, { home });
    expect(b.commit).not.toBe(a.commit);
    expect(b.dir).not.toBe(a.dir);
    expect(fs.existsSync(a.dir)).toBe(true);
  });

  it("copies nested docs and the extras, and ignores everything else", async () => {
    const f = folder();
    fs.mkdirSync(path.join(f, "docs", "deep"));
    fs.writeFileSync(path.join(f, "docs", "deep", "page.md"), "# Page\n");
    fs.writeFileSync(path.join(f, "docs", "image.png"), "not copied");
    fs.writeFileSync(path.join(f, "LICENSE"), "MIT");
    fs.writeFileSync(path.join(f, "NOTICE"), "notice");
    fs.writeFileSync(path.join(f, "package.json"), "{}");
    fs.mkdirSync(path.join(f, ".git"));
    fs.writeFileSync(path.join(f, ".git", "HEAD"), "ref");
    const got = await fetchExtension({ kind: "local", path: f, label: f }, { home });
    const has = (p: string): boolean => fs.existsSync(path.join(got.dir, ...p.split("/")));
    expect(has("docs/deep/page.md")).toBe(true);
    expect(has("LICENSE")).toBe(true);
    expect(has("NOTICE")).toBe(true);
    expect(has("docs/image.png")).toBe(false);
    expect(has("package.json")).toBe(false);
    expect(has(".git")).toBe(false);
  });
});

describe("inspectFolder", () => {
  it("reads the published files", () => {
    const c = inspectFolder(folder(), "books");
    expect(c.manifest.name).toBe("books");
    expect(c.manifestText).toContain('"manifest_version"');
    expect(c.docs.map((d) => d.path)).toEqual(["docs/index.md", "docs/tools.md"]);
    expect(c.extras.map((d) => d.path)).toEqual(["README.md"]);
    expect(c.entry.length).toBeGreaterThan(0);
  });

  it("lists the docs pages by path: a page comes before the folder of the same name", () => {
    const f = folder();
    fs.mkdirSync(path.join(f, "docs", "tools"));
    fs.writeFileSync(path.join(f, "docs", "tools", "advanced.md"), "# Advanced\n");
    // the walk finds docs/tools/advanced.md before docs/tools.md; "." sorts before "/"
    expect(inspectFolder(f, "x").docs.map((d) => d.path)).toEqual(["docs/index.md", "docs/tools.md", "docs/tools/advanced.md"]);
  });

  it("refuses a folder without a manifest", () => {
    const f = folder();
    fs.rmSync(path.join(f, MANIFEST_FILE));
    const e = problem(() => inspectFolder(f, "my label"));
    expect(e.message).toBe(`no ${MANIFEST_FILE} in my label`);
    expect(e.hint).toContain("at its root");
    expect(e.docs).toContain("#lay-out-the-repository");
    fs.mkdirSync(path.join(f, MANIFEST_FILE));
    expect(problem(() => inspectFolder(f, "my label")).message).toBe(`no ${MANIFEST_FILE} in my label`);
  });

  it("lets a bad manifest's own error through", () => {
    const f = folder();
    fs.writeFileSync(path.join(f, MANIFEST_FILE), "{}");
    expect(() => inspectFolder(f, "x")).toThrow(ExtensionManifestError);
  });

  it("refuses a missing entry", () => {
    const f = folder();
    fs.rmSync(path.join(f, "lib", "extension.mjs"));
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("the entry lib/extension.mjs is missing in x");
    expect(e.hint).toContain("never runs a build");
    fs.rmSync(path.join(f, "lib"), { recursive: true });
    expect(problem(() => inspectFolder(f, "x")).message).toBe("the entry lib/extension.mjs is missing in x");
    fs.mkdirSync(path.join(f, "lib", "extension.mjs"), { recursive: true });
    expect(problem(() => inspectFolder(f, "x")).message).toBe("the entry lib/extension.mjs is missing in x");
  });

  it("refuses an entry over 5 MB", () => {
    const f = folder();
    fs.writeFileSync(path.join(f, "lib", "extension.mjs"), Buffer.alloc(LIMITS.entryBytes + 1, 0x20));
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("the entry is larger than 5 MB");
    expect(e.hint).toBe("Bundle only what the tools need.");
  });

  it("refuses an entry that imports packages or files", () => {
    const f = folder();
    fs.writeFileSync(path.join(f, "lib", "extension.mjs"), 'import { DateTime } from "luxon";\nimport "./x.mjs";\nimport fs from "node:fs";\nexport default {};\n');
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("the entry imports ./x.mjs, luxon");
    expect(e.hint).toContain("esbuild --bundle");
  });

  it("accepts an entry that imports only Node's built-in modules", () => {
    const f = folder();
    fs.writeFileSync(path.join(f, "lib", "extension.mjs"), 'import fs from "fs";\nimport { join } from "node:path";\nexport default { api: 1, handlers: {} };\n');
    expect(() => inspectFolder(f, "x")).not.toThrow();
  });

  it("refuses an entry that esbuild minified, with packages left out of the bundle (R2-Q1)", async () => {
    const built = await esbuild.build({
      stdin: { contents: 'import { DateTime } from "luxon";\nexport * from "date-fns";\nexport default { api: 1, handlers: { now: () => DateTime.now() } };\n', loader: "js", resolveDir: work },
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      external: ["luxon", "date-fns"],
      write: false,
      logLevel: "silent",
    });
    const text = built.outputFiles![0]!.text;
    // esbuild --minify leaves no space after import or export
    expect(text).toContain("import{DateTime as ");
    expect(text).toContain('export*from"date-fns"');
    expect(scanEntryImports(text)).toEqual(["date-fns", "luxon"]);
    const f = folder();
    fs.writeFileSync(path.join(f, "lib", "extension.mjs"), text);
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("the entry imports date-fns, luxon");
    expect(e.hint).toContain("esbuild --bundle");
  }, 30_000);

  it("refuses an entry whose imports name exports with strings, as esbuild prints them (R3-Q1)", async () => {
    const built = await esbuild.build({
      stdin: { contents: 'import { "a-b" as x } from "luxon";\nexport { "c-d" } from "date-fns";\nexport default { api: 1, handlers: { now: () => x } };\n', loader: "js", resolveDir: work },
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      external: ["luxon", "date-fns"],
      write: false,
      logLevel: "silent",
    });
    const text = built.outputFiles![0]!.text;
    // an ES2022 string name: the scan used to stop at its quote
    expect(text).toContain('import{"a-b"as ');
    expect(text).toContain('from"date-fns"');
    expect(scanEntryImports(text)).toEqual(["date-fns", "luxon"]);
    const f = folder();
    fs.writeFileSync(path.join(f, "lib", "extension.mjs"), text);
    expect(problem(() => inspectFolder(f, "x")).message).toBe("the entry imports date-fns, luxon");
  }, 30_000);

  it("refuses missing docs", () => {
    const f = folder();
    fs.rmSync(path.join(f, "docs", "index.md"));
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("docs/index.md is missing in x");
    expect(e.hint).toContain('read_docs("extensions/<name>")');
    fs.rmSync(path.join(f, "docs"), { recursive: true });
    expect(problem(() => inspectFolder(f, "x")).message).toBe("docs/index.md is missing in x");
  });

  it("refuses more than 200 docs pages", () => {
    const f = folder();
    for (let i = 0; i < LIMITS.docsFiles; i++) fs.writeFileSync(path.join(f, "docs", `p${i}.md`), "x");
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("docs/ holds more than 200 pages");
    expect(e.hint).toBe("Keep the docs to the pages agents need.");
  });

  it("refuses docs over 2 MB", () => {
    const f = folder();
    fs.writeFileSync(path.join(f, "docs", "big.md"), Buffer.alloc(LIMITS.docsBytes, 0x61));
    expect(problem(() => inspectFolder(f, "x")).message).toBe("docs/ is larger than 2 MB");
  });

  const canLink = ((): boolean => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-ext-probe-"));
    try {
      fs.writeFileSync(path.join(t, "a"), "a");
      fs.symlinkSync(path.join(t, "a"), path.join(t, "b"));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  })();

  it("refuses a path that reports itself as a symbolic link, without needing the platform to make one", () => {
    const f = folder();
    const real = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const s = real(p, o as never) as fs.Stats | undefined;
      return s !== undefined && String(p).endsWith("tools.md") ? Object.assign(Object.create(s), { isSymbolicLink: () => true }) : s;
    }) as never);
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("docs/tools.md is a symbolic link");
    expect(e.hint).toBe("Publish real files: the installer copies files, never links.");
    expect(e.docs).toContain("#lay-out-the-repository");
  });

  it.skipIf(!canLink)("refuses symbolic links: in docs, as the entry, as a folder of the entry, as the manifest, as an extra", () => {
    const outside = path.join(work, "outside.md");
    fs.writeFileSync(outside, "secret");
    let f = folder();
    fs.symlinkSync(outside, path.join(f, "docs", "link.md"));
    const e = problem(() => inspectFolder(f, "x"));
    expect(e.message).toBe("docs/link.md is a symbolic link");
    expect(e.hint).toBe("Publish real files: the installer copies files, never links.");
    expect(e.docs).toContain("#lay-out-the-repository");

    fs.rmSync(f, { recursive: true });
    f = folder();
    fs.rmSync(path.join(f, "lib", "extension.mjs"));
    fs.symlinkSync(outside, path.join(f, "lib", "extension.mjs"));
    expect(problem(() => inspectFolder(f, "x")).message).toBe("lib/extension.mjs is a symbolic link");

    fs.rmSync(f, { recursive: true });
    f = folder();
    const real = path.join(work, "real-lib");
    fs.renameSync(path.join(f, "lib"), real);
    fs.symlinkSync(real, path.join(f, "lib"), "junction");
    expect(problem(() => inspectFolder(f, "x")).message).toBe("lib is a symbolic link");

    fs.rmSync(f, { recursive: true });
    f = folder();
    fs.rmSync(path.join(f, "README.md"));
    fs.symlinkSync(outside, path.join(f, "README.md"));
    expect(problem(() => inspectFolder(f, "x")).message).toBe("README.md is a symbolic link");

    fs.rmSync(f, { recursive: true });
    f = folder();
    const manifest = fs.readFileSync(path.join(f, MANIFEST_FILE));
    fs.rmSync(path.join(f, MANIFEST_FILE));
    fs.writeFileSync(path.join(work, "m.json"), manifest);
    fs.symlinkSync(path.join(work, "m.json"), path.join(f, MANIFEST_FILE));
    expect(problem(() => inspectFolder(f, "x")).message).toBe(`${MANIFEST_FILE} is a symbolic link`);
  });
});

describe("scanEntryImports", () => {
  const cases: [string, string, string[]][] = [
    ["a package", 'import x from "luxon";', ["luxon"]],
    ["a named import", 'import { a, b } from "pkg";', ["pkg"]],
    ["a multi-line import", 'import {\n  a,\n  b,\n} from "pkg";', ["pkg"]],
    ["a namespace import", 'import * as ns from "pkg";', ["pkg"]],
    ["a bare import", 'import "./side.mjs";', ["./side.mjs"]],
    ["a re-export", 'export { a } from "pkg";', ["pkg"]],
    ["a star re-export", 'export * from "pkg";', ["pkg"]],
    ["a dynamic import", 'const m = await import("pkg");', ["pkg"]],
    ["a require", 'const m = require("pkg");', ["pkg"]],
    ["single quotes", "import x from 'pkg';", ["pkg"]],
    ["a relative file", 'import x from "./x.mjs";', ["./x.mjs"]],
    ["node: modules", 'import fs from "node:fs";\nimport p from "node:path";', []],
    ["built-ins without node:", 'import fs from "fs";\nimport r from "fs/promises";', []],
    ["a mix, unique and sorted", 'import b from "zeta";\nimport a from "alpha";\nimport c from "zeta";', ["alpha", "zeta"]],
    ["a string that only looks like an import", 'const s = "import x from pkg";', []],
    ["no imports", "export default { api: 1 };", []],
    ["minified: a named import", 'import{DateTime as e}from"luxon";', ["luxon"]],
    ["minified: a namespace import", 'import*as n from"pkg";', ["pkg"]],
    ["minified: a default and a named import", 'import d,{a}from"pkg";', ["pkg"]],
    ["minified: a bare import", 'import"pkg";', ["pkg"]],
    ["minified: a star re-export", 'export*from"pkg";', ["pkg"]],
    ["minified: a named star re-export", 'export*as n from"pkg";', ["pkg"]],
    ["minified: a re-export", 'export{a as b,c}from"pkg";', ["pkg"]],
    ["minified: imports in a row", 'import{a}from"one";import*as b from"two";export*from"three";', ["one", "three", "two"]],
    ["minified: after a shebang, a function and a comment", '#!/usr/bin/env node\nimport{a}from"one";function f(){}import{b}from"two";/*! banner */import{c}from"three";', ["one", "three", "two"]],
    ["minified: a dynamic import, also with options", 'var m=await import("pkg"),j=await import("data",{with:{type:"json"}});', ["data", "pkg"]],
    ["minified: a require", 'var m=require("pkg");', ["pkg"]],
    ["minified: built-ins", 'import{readFile as r}from"node:fs";import*as p from"path";export*from"fs/promises";', []],
    ["minified: a local export", "var a=1;export{a as default};", []],
    ["minified: words that only contain import or from", 'var u=import.meta.url;importScripts("pkg");export const from="pkg";export default{from:"pkg"};', []],
    ["minified: a string that only looks like an import", `var s="import{a}from'pkg'";`, []],
    ["string names: an import", 'import{"a-b"as o}from"luxon";', ["luxon"]],
    ["string names: an import, then a local export", 'import{"a-b"as a}from"luxon";export{a as"a-b"};', ["luxon"]],
    ["string names: a re-export", 'export{"a-b"}from"luxon";', ["luxon"]],
    ["string names: a quote and a semicolon inside the name", `import{"it's;"as a}from"luxon";`, ["luxon"]],
    ["string names: single quotes", "import{'a-b'as a}from'luxon';", ["luxon"]],
    ["a statement after blank lines and indentation", ';\n\n   \t import x from "pkg";', ["pkg"]],
    ["CRLF line ends", 'var a=1;\r\nimport x from "pkg";', ["pkg"]],
    ["an import keyword inside a comment of the clause", 'import x /*\nimport y*/ from "pkg";', ["pkg"]],
    ["from on a line of its own", 'import x\nfrom\n"pkg";', ["pkg"]],
  ];
  for (const [name, text, expected] of cases) {
    it(name, () => {
      expect(scanEntryImports(text)).toEqual(expected);
    });
  }

  it("scans an entry of the size limit in linear time, whatever it holds (R3-Q2)", () => {
    // each unit once made the scan quadratic: 200 KB of line ends took 32 s, and 5 MB would take hours
    const units = ["\n", "\r\n", "/import ", "\nexport ", '/import{"a-b"as a}', "}import a "];
    for (const size of [64 * 1024, LIMITS.entryBytes]) {
      for (const unit of units) {
        const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const label = `${JSON.stringify(unit)} x ${size}`;
        const started = Date.now();
        const found = scanEntryImports(text);
        const ms = Date.now() - started;
        expect(found, label).toEqual([]);
        // linear: a few milliseconds; the budgets leave room for a loaded machine
        expect(ms, label).toBeLessThan(size === LIMITS.entryBytes ? 3000 : 500);
      }
    }
  }, 60_000);
});

// runs git (one fetch, five git processes): slow on Windows under load
describe("cachedExtension", { timeout: 60_000 }, () => {
  it("is null for a missing or broken folder", () => {
    expect(cachedExtension(home, "books", "abc")).toBeNull();
    const dir = codeDir(home, "books", "abc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), "{ not json");
    expect(cachedExtension(home, "books", "abc")).toBeNull();
  });

  it("describes what a fetch cached", async () => {
    const f = await fetchExtension({ kind: "git", url, ref: "v0.1.0", label: url }, { home, tmpRoot: work });
    const c = cachedExtension(home, "books", f.commit)!;
    expect(c).toMatchObject({ dir: f.dir, commit: f.commit, manifestSha256: f.manifestSha256, entrySha256: f.entrySha256 });
    expect(c.manifest).toEqual(f.manifest);
  });
});
