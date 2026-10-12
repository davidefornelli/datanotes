/**
 * Filesystem-backed fake `App` for table-engine tests (phases 33–35): supports create,
 * createFolder, process, rename, trash, getFiles, tolerant frontmatter like Obsidian.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App, LinkRewrite, LinksAfterMoveOptions, StoreAdapter, TFile } from "../../src/core/host";
import { LinkResolver, linkText, rewriteLinks } from "../../src/node/links";
import {
  buildMarkdownWithFrontmatter,
  readOrderedFromMarkdown,
} from "../../src/core/frontmatter";
import { invalidateFiles } from "../../src/core/file-cache";
import { METASTORE_FILE } from "../../src/core/metastore";
import { DEFAULT_SETTINGS, mergeWithDefaults, type DatanotesSettings } from "../../src/core/settings";
import { NodeFile, openNodeVault } from "../../src/node/node-app";

/** `VAULT_HOST=node`: run the engine tests on the headless Node host instead of the fake App. */
const NODE_HOST = process.env.VAULT_HOST === "node";

export interface DbVault {
  root: string;
  /** The engine's store: a folder of its own, outside the vault (`store:<path>` in the helpers below). */
  storeRoot: string;
  app: App;
  settings: DatanotesSettings;
  write(rel: string, text: string): TFile;
  read(rel: string): string;
  /** Delete a file by hand (the headless host's index learns it as its watcher would). */
  remove(rel: string): void;
  /**
   * Rename a note as the vault's own rename does (links to it are not rewritten). True when the
   * host announced it with its `rename` event (the headless host); the fake App has no events.
   */
  rename(from: string, to: string): Promise<boolean>;
  exists(rel: string): boolean;
  file(rel: string): TFile;
  list(): string[];
  /** The file on disk: a vault path, or a store path (`store:<path>`). */
  abs(rel: string): string;
  /** Every file, the engine's store included (as `store:<path>`). */
  listAll(): string[];
}

/** A store adapter on a folder (the engine's `App.store`), as Obsidian's DataAdapter would be. */
export function folderStore(dir: string): StoreAdapter {
  const full = (p: string) => path.join(dir, ...p.split("/").filter(Boolean));
  return {
    exists: async (p: string) => fs.existsSync(full(p)),
    read: async (p: string) => fs.readFileSync(full(p), "utf8"),
    write: async (p: string, d: string) => {
      fs.mkdirSync(path.dirname(full(p)), { recursive: true });
      fs.writeFileSync(full(p), d);
    },
    append: async (p: string, d: string) => fs.appendFileSync(full(p), d),
    list: async (p: string) => {
      const ents = fs.readdirSync(full(p), { withFileTypes: true });
      const rel = (n: string) => (p === "" ? n : `${p}/${n}`);
      return { files: ents.filter((e) => e.isFile()).map((e) => rel(e.name)), folders: ents.filter((e) => e.isDirectory()).map((e) => rel(e.name)) };
    },
    mkdir: async (p: string) => void fs.mkdirSync(full(p), { recursive: true }),
    remove: async (p: string) => fs.rmSync(full(p)),
    rmdir: async (p: string, recursive: boolean) => fs.rmSync(full(p), { recursive }),
    rename: async (a: string, b: string) => {
      fs.mkdirSync(path.dirname(full(b)), { recursive: true });
      fs.renameSync(full(a), full(b));
    },
  };
}

function walk(root: string, dir = root, out: string[] = [], hidden = false): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && !hidden) continue; // like Obsidian: dot-folders and dot-files are not indexed
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(root, abs, out, hidden);
    else out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

function tfile(rel: string, root?: string): TFile {
  const name = rel.split("/").pop()!;
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const f = { path: rel, name, extension: ext, basename: name.replace(/\.[^.]+$/, "") } as Record<string, unknown>;
  if (root !== undefined) {
    // Like Obsidian's in-memory TFile.stat (read lazily here, so it is current).
    Object.defineProperty(f, "stat", {
      get() {
        const abs = path.join(root, ...rel.split("/"));
        if (!fs.existsSync(abs)) return undefined;
        const s = fs.statSync(abs);
        return { mtime: s.mtimeMs, size: s.size, ctime: s.ctimeMs };
      },
    });
  }
  return f as unknown as TFile;
}

export function createDbVault(
  files: Record<string, string> = {},
  settingsOverrides: Partial<DatanotesSettings> = {},
  /** `host`: the fake App or the headless Node host whatever `VAULT_HOST` says (tests of one host's behavior). */
  options: { host?: "fake" | "node" } = {},
): DbVault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-db-"));
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-store-"));
  // `store:<path>` is a file of the engine's store (as the engine names them), anything else a vault path
  const full = (rel: string) => (rel.startsWith("store:") ? path.join(storeRoot, ...rel.slice("store:".length).split("/").filter(Boolean)) : path.join(root, ...rel.split("/")));
  const inStore = (rel: string) => rel.startsWith("store:");
  // The tests' database is an existing `Datanotes/` folder (a new database's default is `datanotes`).
  const settings = mergeWithDefaults({ ...DEFAULT_SETTINGS, databaseFolder: TEST_DATABASE_FOLDER, ...settingsOverrides });

  const fmOf = (rel: string): Record<string, unknown> | undefined => {
    if (!fs.existsSync(full(rel))) return undefined;
    const { ordered } = readOrderedFromMarkdown(fs.readFileSync(full(rel), "utf8"));
    if (ordered.length === 0) return undefined;
    return Object.fromEntries(ordered);
  };

  const md = () => walk(root).filter((p) => p.endsWith(".md"));
  // Like Obsidian's index: a path in another case is no file, also where the disk ignores case.
  let realRoot: string | undefined;
  const spelled = (p: string): boolean => {
    if (process.platform === "linux") return true; // the disk tells the cases apart
    const parts = p.split("/").filter(Boolean);
    if (process.platform === "win32") {
      realRoot ??= fs.realpathSync.native(root);
      return fs.realpathSync.native(full(p)) === path.join(realRoot, ...parts); // Windows gives the true case
    }
    return parts.every((part, i) => fs.readdirSync(path.join(root, ...parts.slice(0, i))).includes(part));
  };

  const app = {
    plugins: { getPlugin: () => null },
    store: folderStore(storeRoot),
    vault: {
      getMarkdownFiles: () => md().map((p) => tfile(p, root)),
      getFiles: () => walk(root).map((p) => tfile(p, root)),
      getAbstractFileByPath(p: string) {
        if (p.split("/").some((part) => part.startsWith("."))) return null; // not indexed by Obsidian
        const f = full(p);
        if (!fs.existsSync(f) || !spelled(p)) return null;
        if (fs.statSync(f).isDirectory()) {
          // Like TFolder: direct children, files as TFile.
          return {
            path: p,
            get children() {
              return fs.readdirSync(f, { withFileTypes: true }).map((e) => {
                const rel = p === "" ? e.name : `${p}/${e.name}`;
                return e.isDirectory() ? { path: rel, children: [] } : tfile(rel, root);
              });
            },
          };
        }
        return tfile(p, root);
      },
      read: async (f: TFile) => fs.readFileSync(full(f.path), "utf8"),
      create: async (p: string, content: string) => {
        if (fs.existsSync(full(p))) throw new Error(`exists ${p}`);
        fs.writeFileSync(full(p), content);
        return tfile(p);
      },
      createFolder: async (p: string) => {
        fs.mkdirSync(full(p));
      },
      process: async (f: TFile, fn: (t: string) => string) => {
        const next = fn(fs.readFileSync(full(f.path), "utf8"));
        fs.writeFileSync(full(f.path), next);
        return next;
      },
      trash: async (f: TFile) => {
        fs.rmSync(full(f.path));
      },
      delete: async (f: TFile, force?: boolean) => {
        fs.rmSync(full(f.path), { recursive: force === true });
      },
      // Raw file access, as Obsidian's DataAdapter (also for paths Obsidian does not index).
      adapter: {
        exists: async (p: string) => fs.existsSync(full(p)),
        read: async (p: string) => fs.readFileSync(full(p), "utf8"),
        write: async (p: string, d: string) => fs.writeFileSync(full(p), d),
        append: async (p: string, d: string) => fs.appendFileSync(full(p), d),
        list: async (p: string) => {
          const ents = fs.readdirSync(full(p), { withFileTypes: true });
          const rel = (n: string) => (p === "" ? n : `${p}/${n}`);
          return { files: ents.filter((e) => e.isFile()).map((e) => rel(e.name)), folders: ents.filter((e) => e.isDirectory()).map((e) => rel(e.name)) };
        },
        mkdir: async (p: string) => fs.mkdirSync(full(p), { recursive: true }),
        remove: async (p: string) => fs.rmSync(full(p)),
        rmdir: async (p: string, recursive: boolean) => fs.rmSync(full(p), { recursive }),
        rename: async (a: string, b: string) => fs.renameSync(full(a), full(b)),
      },
    },
    fileManager: {
      processFrontMatter: async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
        const text = fs.readFileSync(full(f.path), "utf8");
        const { ordered, body } = readOrderedFromMarkdown(text);
        const rec = Object.fromEntries(ordered) as Record<string, unknown>;
        fn(rec);
        fs.writeFileSync(full(f.path), buildMarkdownWithFrontmatter(Object.entries(rec), body));
      },
      renameFile: async (f: TFile, newPath: string) => {
        fs.mkdirSync(path.dirname(full(newPath)), { recursive: true });
        fs.renameSync(full(f.path), full(newPath));
      },
      trashFile: async (f: TFile) => {
        fs.rmSync(full(f.path));
      },
      // Like the headless host: the links to files moved by hand, rewritten as a rename would.
      linksAfterMove: async (moves: ReadonlyMap<string, string>, options: LinksAfterMoveOptions = {}): Promise<LinkRewrite[]> => {
        const now = walk(root);
        const present = new Set(now);
        const reoccupied = options.reoccupied;
        const moved = new Map([...moves].filter(([from, to]) => from !== to && present.has(to) && (!present.has(from) || reoccupied !== undefined)));
        if (moved.size === 0) return [];
        const back = new Map([...moved].map(([from, to]) => [to, from]));
        const before = new LinkResolver({ paths: () => now.filter((p) => back.has(p) || !moved.has(p)).map((p) => back.get(p) ?? p) });
        const after = new LinkResolver({ paths: () => now });
        const out: LinkRewrite[] = [];
        for (const p of now.filter((x) => x.endsWith(".md"))) {
          const text = fs.readFileSync(full(p), "utf8");
          const followed = new Map([...moved].filter(([from, to]) => !present.has(from) || to === p || reoccupied!(from, p, text)));
          const r = rewriteLinks(text, p, (lp, s) => before.resolve(lp, s), followed, (dest, s) => linkText(after, dest, s, "shortest", true), back.get(p) ?? p, (lp, s) => after.resolve(lp, s));
          if (r.changed > 0) out.push({ path: p, before: text, after: r.text });
        }
        return out;
      },
    },
    metadataCache: {
      getFileCache(f: TFile) {
        const frontmatter = fmOf(f.path);
        return frontmatter ? { frontmatter } : {};
      },
      getFirstLinkpathDest(linkpath: string, _source: string): TFile | null {
        const norm = linkpath.replace(/^\/+/, "");
        const withMd = norm.endsWith(".md") ? norm : `${norm}.md`;
        const all = md();
        if (all.includes(withMd)) return tfile(withMd);
        const base = path.posix.basename(norm, ".md");
        const hit = all.find((p) => path.posix.basename(p, ".md") === base);
        return hit ? tfile(hit) : null;
      },
    },
  } as unknown as App;

  // Like Obsidian: every [[link]] in each markdown file, resolved to a vault path.
  Object.defineProperty(app.metadataCache, "resolvedLinks", {
    get() {
      const out: Record<string, Record<string, number>> = {};
      for (const src of md()) {
        const text = fs.readFileSync(full(src), "utf8");
        const dests: Record<string, number> = {};
        for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
          const d = app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), src);
          if (d) dests[d.path] = (dests[d.path] ?? 0) + 1;
        }
        out[src] = dests;
      }
      return out;
    },
  });

  const v: DbVault = {
    root,
    storeRoot,
    abs: full,
    app,
    settings,
    write(rel, text) {
      fs.mkdirSync(path.dirname(full(rel)), { recursive: true });
      fs.writeFileSync(full(rel), text);
      invalidateFiles(app, [rel]); // like Obsidian's modify event for a hand edit
      return tfile(rel);
    },
    read: (rel) => fs.readFileSync(full(rel), "utf8"),
    remove(rel) {
      fs.rmSync(full(rel));
      invalidateFiles(app, [rel]);
    },
    async rename(from, to) {
      fs.mkdirSync(path.dirname(full(to)), { recursive: true });
      fs.renameSync(full(from), full(to));
      invalidateFiles(app, [from, to]);
      return false;
    },
    exists: (rel) => fs.existsSync(full(rel)),
    file: (rel) => tfile(rel),
    list: () => walk(root),
    listAll: () => [...walk(root, root, [], true), ...walk(storeRoot, storeRoot, [], true).map((p) => `store:${p}`)],
  };
  if (options.host === "node" || (options.host === undefined && NODE_HOST)) {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(full(rel)), { recursive: true });
      fs.writeFileSync(full(rel), text);
    }
    const host = openNodeVault(root, undefined, { store: storeRoot });
    const nodeApp = host.app as unknown as App;
    return {
      ...v,
      app: nodeApp,
      write(rel, text) {
        fs.mkdirSync(path.dirname(full(rel)), { recursive: true });
        fs.writeFileSync(full(rel), text);
        if (inStore(rel)) return tfile(rel);
        invalidateFiles(nodeApp, [rel]);
        // A hand edit, as the watcher would report it (also when mtime and size did not move).
        if (!host.vault.syncPath(rel)) {
          const f = host.vault.getAbstractFileByPath(rel);
          if (f instanceof NodeFile) {
            f.stat = { ...f.stat, mtime: fs.statSync(full(rel)).mtimeMs, size: fs.statSync(full(rel)).size };
            host.metadataCache.changed(f, false);
          }
        }
        return (host.vault.getAbstractFileByPath(rel) as TFile | null) ?? tfile(rel);
      },
      remove(rel) {
        fs.rmSync(full(rel));
        if (inStore(rel)) return;
        invalidateFiles(nodeApp, [rel]);
        host.vault.syncPath(rel); // the watcher's delete event
      },
      async rename(from, to) {
        await host.vault.move(host.vault.getAbstractFileByPath(from)!, to);
        invalidateFiles(nodeApp, [from, to]);
        return true;
      },
      file: (rel) => (host.vault.getAbstractFileByPath(rel) as TFile | null) ?? tfile(rel),
    };
  }
  for (const [rel, text] of Object.entries(files)) v.write(rel, text);
  return v;
}

/** The database folder of a test vault (createDbVault's default `databaseFolder`). */
export const TEST_DATABASE_FOLDER = "Datanotes";

/** The metastore of a test vault (default `databaseFolder`). */
export const METASTORE = `${TEST_DATABASE_FOLDER}/${METASTORE_FILE}`;

/** A `log` table (main.public.log in the metastore) with two rows used across engine tests. */
export const LOG_YAML = `catalogs:
  main:
    schemas:
      public:
        tables:
          log:
            options:
              partition: "{occurred_at:YYYY/MM/DD}"
              filename: "{occurred_at:YYYY-MM-DD} {kind}"
              archive: _archive
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: kind, type: enum, values: [alcohol, mood, walk], required: true }
              - { name: occurred_at, type: datetime, required: true }
              - { name: metric_drinks, type: number, min: 0, max: 30 }
              - { name: people, type: list, items: link }
`;

/** {@link LOG_YAML} plus more `main.public` tables (YAML indented as if `tables:` were the root). */
export function withTables(entries: string): string {
  const pad = entries
    .trimEnd()
    .split("\n")
    .map((l) => (l === "" ? l : `          ${l}`))
    .join("\n");
  return `${LOG_YAML}${pad}\n`;
}

/** Folder of the log table's rows. */
export const LOG_DIR = "Datanotes/main/public/log";

export function logVault(extra: Record<string, string> = {}): DbVault {
  return createDbVault({
    [METASTORE]: LOG_YAML,
    "Daily/a.md":
      "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000a\nkind: alcohol\noccurred_at: 2026-09-25T22:30\nmetric_drinks: 7\n---\nA\n",
    "Daily/b.md": "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: mood\noccurred_at: 2026-09-26T08:00\n---\nB\n",
    ...extra,
  });
}
