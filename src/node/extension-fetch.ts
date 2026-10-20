/**
 * Fetching an extension: a pinned git tag or commit, or a local folder, becomes an immutable copy under
 * `<data home>/extensions/code/<name>/<commit>/`. The installer reads what is published (manifest, entry,
 * docs), checks it, and copies only those files: it never runs a build, an install script or the
 * extension's code, never follows a symbolic link and never copies `.git`.
 *
 * A git URL with a user name or a password (`https://user:token@host/x.git`) is used to fetch, but what
 * it returns for the record, the label and every message is the URL without them: the registry shows
 * records to every token.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { codeDir, fileSha256, sha256Hex } from "../api/extension-files";
import { compareVersions, ExtensionError, EXT_DOCS, MANIFEST_FILE, parseManifest, parseVersion, type ExtensionManifest } from "../api/extension-manifest";
import type { ExtensionSourceRecord } from "../api/extension-record";
import { runGit, type GitRunner } from "./git-sync";

export type ExtensionSource =
  /** `url` has no credentials (it goes to the record); `cloneUrl` is what git is given, when it differs. */
  | { kind: "git"; url: string; ref: string | null; label: string; cloneUrl?: string }
  | { kind: "local"; path: string; label: string };

export interface FetchedExtension {
  /** The cache folder. */
  dir: string;
  commit: string;
  manifest: ExtensionManifest;
  manifestSha256: string;
  entrySha256: string;
  /** What the record keeps (ref filled with the tag or commit used). */
  source: ExtensionSourceRecord;
  label: string;
}

export interface FetchOptions {
  home: string;
  git?: GitRunner;
  tmpRoot?: string;
}

export const LIMITS = { entryBytes: 5 * 1024 * 1024, docsBytes: 2 * 1024 * 1024, docsFiles: 200 };

export interface FolderContents {
  manifest: ExtensionManifest;
  manifestText: string;
  entry: Uint8Array;
  docs: { path: string; bytes: Uint8Array }[];
  extras: { path: string; bytes: Uint8Array }[];
}

const FETCH_HINT =
  "Check the address and that git reaches it: git ls-remote <url>. A private repository needs git's credentials (an SSH key in the agent, or Git Credential Manager).";

const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const GIT_URL = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/;
const GITHUB = /^(?:github:)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@(.+))?$/;
const EXTRAS = ["README.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE"];

// --- credentials ------------------------------------------------------------------------------------

/**
 * The URL without a password, and without a user name unless it is an ssh:// URL (there the user
 * name is part of the address, not a secret). `git@host:path` keeps its `git@`.
 */
export function stripCredentials(url: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(url);
  if (!m) return url;
  const at = m[2]!.lastIndexOf("@");
  if (at < 0) return url;
  const userinfo = m[2]!.slice(0, at);
  const host = m[2]!.slice(at + 1);
  const user = m[1]!.toLowerCase() === "ssh://" ? userinfo.split(":")[0]! : "";
  return `${m[1]}${user === "" ? "" : `${user}@`}${host}${m[3]}`;
}

/** A message from git with every `scheme://user:secret@` reduced to `scheme://`, and the given URL as its safe form. */
function redact(text: string, url?: string): string {
  let out = text;
  if (url !== undefined && url !== stripCredentials(url)) out = out.split(url).join(stripCredentials(url));
  return out.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g, "$1");
}

function lastLine(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.length === 0 ? fallback : lines[lines.length - 1]!.trim();
}

function fetchError(message: string): ExtensionError {
  return new ExtensionError(message, FETCH_HINT, EXT_DOCS.install, "fetch");
}

// --- sources ----------------------------------------------------------------------------------------

/** Pin rule (D3): a version tag or a full commit id; a branch moves, so it is refused. */
export function checkRef(ref: string): void {
  if (TAG.test(ref) || COMMIT.test(ref)) return;
  throw new ExtensionError(
    `ref "${ref}" is not a version tag or a commit`,
    "Pin a version tag such as v1.2.0, or a full commit id (40 hex characters): a branch moves, so the code you approved could change.",
    EXT_DOCS.install,
  );
}

export function parseSource(text: string, cwd: string = process.cwd()): ExtensionSource {
  const t = text.trim();
  if (t === "") throw new ExtensionError("no source given", "Give a git URL with #<tag>, owner/repo@<tag>, or a folder.", EXT_DOCS.install);
  const abs = path.resolve(cwd, t);
  const pathLike = /^(\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(t);
  if (pathLike || fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ExtensionError(`no folder ${abs}`, "Check the path, or give a git URL.", EXT_DOCS.install);
    }
    const p = abs.split("\\").join("/");
    return { kind: "local", path: p, label: p };
  }
  if (GIT_URL.test(t)) {
    const hash = t.lastIndexOf("#");
    const url = hash < 0 ? t : t.slice(0, hash);
    const rawRef = hash < 0 ? "" : t.slice(hash + 1);
    const ref = rawRef === "" ? null : rawRef;
    if (ref !== null) checkRef(ref);
    return gitSource(url, ref, t);
  }
  const g = GITHUB.exec(t);
  if (g) {
    const ref = g[3] ?? null;
    if (ref !== null) checkRef(ref);
    return { kind: "git", url: `https://github.com/${g[1]}/${g[2]}.git`, ref, label: t };
  }
  throw new ExtensionError(
    `"${t}" is not a source`,
    "Give a git URL with #<tag> (https://example.com/team/ext.git#v1.0.0), owner/repo@<tag> for GitHub, or a folder (./my-extension).",
    EXT_DOCS.install,
  );
}

function gitSource(url: string, ref: string | null, text: string): ExtensionSource {
  const safe = stripCredentials(url);
  const label = safe === url ? text : text.replace(url, safe);
  return safe === url ? { kind: "git", url, ref, label } : { kind: "git", url: safe, ref, label, cloneUrl: url };
}

/** The tag of the newest version a repository has. */
export async function newestTag(url: string, git: GitRunner = runGit): Promise<string> {
  const shown = stripCredentials(url);
  const r = await git(["ls-remote", "--tags", "--refs", url], os.tmpdir());
  if (r.code !== 0) throw fetchError(`git could not list the tags of ${shown}: ${redact(lastLine(r.stderr, `exit code ${r.code}`), url)}`);
  let best: string | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\S+\s+refs\/tags\/(.+)$/.exec(line.trim());
    if (!m) continue;
    const tag = m[1]!;
    if (!parseVersion(tag.replace(/^v/, ""))) continue;
    if (best === null || compareVersions(tag.replace(/^v/, ""), best.replace(/^v/, "")) > 0) best = tag;
  }
  if (best === null) {
    throw new ExtensionError(`no version tag in ${shown}`, "Tag a release (git tag v0.1.0, then git push --tags), or pass a commit id after #.", EXT_DOCS.publish);
  }
  return best;
}

// --- reading a folder -------------------------------------------------------------------------------

function symlinkError(rel: string): ExtensionError {
  return new ExtensionError(`${rel} is a symbolic link`, "Publish real files: the installer copies files, never links.", EXT_DOCS.layout);
}

/** lstat that refuses a symbolic link; null when the path is missing. */
function statNoLink(abs: string, rel: string): fs.Stats | null {
  const s = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (s === undefined) return null;
  if (s.isSymbolicLink()) throw symlinkError(rel);
  return s;
}

function layoutError(message: string, hint: string): ExtensionError {
  return new ExtensionError(message, hint, EXT_DOCS.layout);
}

function walkDocs(abs: string, rel: string, out: { rel: string; abs: string; size: number }[]): void {
  const names = fs.readdirSync(abs).sort();
  for (const name of names) {
    const a = path.join(abs, name);
    const r = `${rel}/${name}`;
    const s = statNoLink(a, r)!;
    if (s.isDirectory()) walkDocs(a, r, out);
    else if (s.isFile() && name.endsWith(".md")) out.push({ rel: r, abs: a, size: s.size });
  }
}

export function inspectFolder(folder: string, label: string): FolderContents {
  const manifestAbs = path.join(folder, MANIFEST_FILE);
  const ms = statNoLink(manifestAbs, MANIFEST_FILE);
  if (ms === null || !ms.isFile()) {
    throw layoutError(`no ${MANIFEST_FILE} in ${label}`, "An extension's repository has datanotes-extension.json at its root.");
  }
  const manifestText = fs.readFileSync(manifestAbs, "utf8");
  const manifest = parseManifest(manifestText, `${label}/${MANIFEST_FILE}`);

  // The entry: every folder on its way is checked too (a linked `lib/` would lead out of the repository).
  const segments = manifest.entry.split("/");
  let cur = folder;
  let entryStat: fs.Stats | null = null;
  for (let i = 0; i < segments.length; i++) {
    cur = path.join(cur, segments[i]!);
    entryStat = statNoLink(cur, segments.slice(0, i + 1).join("/"));
    if (entryStat === null) break;
  }
  if (entryStat === null || !entryStat.isFile()) {
    throw layoutError(`the entry ${manifest.entry} is missing in ${label}`, "Build the extension and commit its entry file: the installer never runs a build or an install script.");
  }
  if (entryStat.size > LIMITS.entryBytes) throw layoutError("the entry is larger than 5 MB", "Bundle only what the tools need.");
  const entry = fs.readFileSync(cur);
  const imports = scanEntryImports(Buffer.from(entry).toString("utf8"));
  if (imports.length > 0) {
    throw layoutError(
      `the entry imports ${imports.join(", ")}`,
      "Bundle every dependency into the entry (esbuild --bundle --platform=node --format=esm): only Node's built-in modules may stay as imports.",
    );
  }

  const docsAbs = path.join(folder, "docs");
  const docsStat = statNoLink(docsAbs, "docs");
  const index = statNoLink(path.join(docsAbs, "index.md"), "docs/index.md");
  if (docsStat === null || !docsStat.isDirectory() || index === null || !index.isFile()) {
    throw layoutError(`docs/index.md is missing in ${label}`, 'Add docs/index.md: agents read it with read_docs("extensions/<name>").');
  }
  const found: { rel: string; abs: string; size: number }[] = [];
  walkDocs(docsAbs, "docs", found);
  // path order, as the cache and the content commit use it; two pages never share a path, so no pair is equal
  found.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  if (found.length > LIMITS.docsFiles) throw layoutError("docs/ holds more than 200 pages", "Keep the docs to the pages agents need.");
  if (found.reduce((n, f) => n + f.size, 0) > LIMITS.docsBytes) throw layoutError("docs/ is larger than 2 MB", "Keep the docs to the pages agents need.");
  const docs = found.map((f) => ({ path: f.rel, bytes: new Uint8Array(fs.readFileSync(f.abs)) }));

  const extras: { path: string; bytes: Uint8Array }[] = [];
  for (const name of EXTRAS) {
    const s = statNoLink(path.join(folder, name), name);
    if (s !== null && s.isFile()) extras.push({ path: name, bytes: new Uint8Array(fs.readFileSync(path.join(folder, name))) });
  }
  return { manifest, manifestText, entry: new Uint8Array(entry), docs, extras };
}

/**
 * The module specifiers an entry file imports that are not Node's built-in modules (relative ones count),
 * minified or not, string export names included. It reads literal names only: a name built at run time escapes
 * it (a packaging check, not a sandbox). It runs in linear time: each statement is read once.
 */
export function scanEntryImports(text: string): string[] {
  const patterns = [
    // import … from "x" and export … from "x"; no space is needed after the keyword: import{a}from"x", export*from"x"
    // A string in the clause is skipped whole: import{"a-b"as a}from"x". The clause ends at ; ( ) or a lone quote,
    // and before the next statement that starts with import or export, which is tried on its own
    /(?:^|[;\n\r}\/])[^\S\n\r]*(?:import|export)(?![\w$])(?:(?![\n\r}\/][^\S\n\r]*(?:import|export)(?![\w$]))[^;'"()]|"[^"\n]*"|'[^'\n]*')*?\bfrom\s*["']([^"']+)["']/g,
    // import "x" and import"x"; [^\S\n\r] is white space but not a line end: a run of line ends is read once
    /(?:^|[;\n\r}\/])[^\S\n\r]*import\s*["']([^"']+)["']/g,
    // import("x"), also with options: import("x",{with:{type:"json"}})
    /\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const builtin = new Set(builtinModules);
  const found = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1]!;
      if (!spec.startsWith("node:") && !builtin.has(spec)) found.add(spec);
    }
  }
  return [...found].sort();
}

// --- the cache --------------------------------------------------------------------------------------

function fromDir(dir: string, commit: string, source: ExtensionSourceRecord, label: string): FetchedExtension | null {
  try {
    const manifestFile = path.join(dir, MANIFEST_FILE);
    const manifest = parseManifest(fs.readFileSync(manifestFile, "utf8"), `${label}/${MANIFEST_FILE}`);
    return { dir, commit, manifest, manifestSha256: fileSha256(manifestFile), entrySha256: fileSha256(path.join(dir, ...manifest.entry.split("/"))), source, label };
  } catch {
    return null;
  }
}

/** What the cache holds for a name and a commit; null when it holds nothing usable. The source is the cache folder itself. */
export function cachedExtension(home: string, name: string, commit: string): FetchedExtension | null {
  const dir = codeDir(home, name, commit);
  return fromDir(dir, commit, { kind: "local", path: dir.split("\\").join("/") }, dir);
}

function writeFile(file: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function cacheFolder(home: string, c: FolderContents, commit: string, source: ExtensionSourceRecord, label: string): FetchedExtension {
  const name = c.manifest.name;
  const dir = codeDir(home, name, commit);
  const manifestBytes = Buffer.from(c.manifestText, "utf8");
  const manifestSha256 = sha256Hex(manifestBytes);
  const entrySha256 = sha256Hex(c.entry);

  const reuse = (): FetchedExtension => {
    const held = fromDir(dir, commit, source, label);
    if (held === null || held.manifestSha256 !== manifestSha256 || held.entrySha256 !== entrySha256) {
      throw new ExtensionError(`the code cache holds another ${name} at ${commit}`, `Delete the folder ${dir} and run the command again.`, EXT_DOCS.where);
    }
    return held;
  };
  if (fs.existsSync(dir)) return reuse();

  const partial = `${dir}.partial-${randomBytes(4).toString("hex")}`;
  try {
    writeFile(path.join(partial, MANIFEST_FILE), manifestBytes);
    writeFile(path.join(partial, ...c.manifest.entry.split("/")), c.entry);
    for (const f of [...c.docs, ...c.extras]) writeFile(path.join(partial, ...f.path.split("/")), f.bytes);
    try {
      fs.renameSync(partial, dir);
    } catch (e) {
      if (!fs.existsSync(dir)) throw e;
      // Another install won the race: its copy is the one to check.
      fs.rmSync(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return reuse();
    }
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw e;
  }
  return { dir, commit, manifest: c.manifest, manifestSha256, entrySha256, source, label };
}

// --- fetching ---------------------------------------------------------------------------------------

function localCommit(c: FolderContents): string {
  const h = createHash("sha256");
  h.update(c.manifestText);
  h.update("\0");
  h.update(c.entry);
  h.update("\0");
  for (const d of c.docs) {
    h.update(d.path);
    h.update("\0");
    h.update(d.bytes);
    h.update("\0");
  }
  return `local-${h.digest("hex").slice(0, 12)}`;
}

export async function fetchExtension(source: ExtensionSource, o: FetchOptions): Promise<FetchedExtension> {
  if (source.kind === "local") {
    const c = inspectFolder(source.path, source.label);
    return cacheFolder(o.home, c, localCommit(c), { kind: "local", path: source.path }, source.label);
  }
  const git = o.git ?? runGit;
  const url = source.url;
  const target = source.cloneUrl ?? url;
  const ref = source.ref ?? (await newestTag(target, git));
  const tmp = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), "dn-ext-"));
  try {
    const repo = path.join(tmp, "repo");
    const step = async (args: string[], cwd: string): Promise<string> => {
      const r = await git(args, cwd);
      if (r.code !== 0) throw fetchError(`git could not fetch ${url} at ${ref}: ${redact(lastLine(r.stderr, `exit code ${r.code}`), target)}`);
      return r.stdout;
    };
    // a tag is fetched as refs/tags/<tag>, never through clone --branch, which takes a branch of the same name;
    // checkout peels an annotated tag to its commit
    await step(["init", "-q", repo], tmp);
    await step(["config", "core.autocrlf", "false"], repo);
    await step(["fetch", "--depth", "1", target, COMMIT.test(ref) ? ref : `refs/tags/${ref}`], repo);
    await step(["checkout", "-q", "--detach", "FETCH_HEAD"], repo);
    const commit = (await step(["rev-parse", "HEAD"], repo)).trim();
    // the cache folder and the record take this id: 40 hex, the rule the extension host checks (RECORD_COMMIT)
    if (!COMMIT.test(commit) || (COMMIT.test(ref) && commit !== ref)) throw fetchError(`git could not fetch ${url} at ${ref}: git gave commit ${commit} for ${ref}`);
    const c = inspectFolder(repo, source.label);
    const tagVersion = ref.replace(/^v/, "");
    if (!COMMIT.test(ref) && tagVersion !== c.manifest.version) {
      throw new ExtensionError(
        `the tag ${ref} holds version ${c.manifest.version}`,
        'Tag each release with its manifest version (v1.2.0 for "version": "1.2.0"), or pin the commit.',
        EXT_DOCS.publish,
      );
    }
    return cacheFolder(o.home, c, commit, { kind: "git", url, ref }, source.label);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
