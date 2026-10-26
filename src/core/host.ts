/**
 * VaultHost: everything the engine needs from the environment that holds the vault. It is the
 * subset of Obsidian's `App` API the engine uses, so inside Obsidian the plugin passes its `App`
 * directly (Obsidian's App satisfies this interface); outside it, the Node host implements it on the
 * filesystem. The engine (`core/`) never imports `obsidian`.
 */

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

/** A file of the vault (`path` relative to the vault root, forward slashes). */
export interface TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat?: FileStats;
}

/** A folder of the vault; `children` are files and folders. */
export interface TFolder {
  path: string;
  name?: string;
  children: TAbstractFile[];
}

/** A file or a folder (tell them apart with `"extension" in f` / `"children" in f`). */
export type TAbstractFile = TFile | TFolder | { path: string; name?: string };

export type EventRef = object;

/** Raw file access, also for paths the index does not list (dot-files and dot-folders). */
export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  /**
   * Size and modification time of a file, null when it does not exist (Obsidian's DataAdapter has
   * it). Optional: without it the engine reads its store files again instead of keeping them.
   */
  stat?(path: string): Promise<{ size: number; mtime: number } | null>;
  /**
   * A binary file's bytes (Obsidian's DataAdapter has it). Optional: without it, and without
   * {@link writeBinary}, the engine writes the files it would compress as plain text.
   */
  readBinary?(path: string): Promise<ArrayBuffer>;
  /** Write a binary file (Obsidian's DataAdapter has it). Optional, with {@link readBinary}. */
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
  /**
   * Make what was written to these files durable (fsync), once at the end of an operation of
   * the engine's store. Optional: a host without it leaves that to the operating system.
   */
  sync?(paths: readonly string[]): Promise<void>;
}

export interface Vault {
  adapter: VaultAdapter;
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getMarkdownFiles(): TFile[];
  getFiles(): TFile[];
  getRoot?(): TFolder;
  read(file: TFile): Promise<string>;
  /** Read-modify-write of a file's whole text. */
  process(file: TFile, fn: (data: string) => string): Promise<string>;
  create(path: string, data: string): Promise<TFile>;
  createFolder(path: string): Promise<unknown>;
  delete(file: TAbstractFile, force?: boolean): Promise<void>;
  trash(file: TAbstractFile, system: boolean): Promise<void>;
  on(name: "create" | "modify" | "delete", cb: (file: TAbstractFile) => unknown): EventRef;
  /** `info` (optional): what the host knows of the rename, e.g. that another program made it. */
  on(name: "rename", cb: (file: TAbstractFile, oldPath: string, info?: RenameInfo) => unknown): EventRef;
  /** Stop listening (a ref returned by `on`). */
  offref?(ref: EventRef): void;
}

/** Parsed metadata of a note. */
export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: { tag: string }[];
}

export interface MetadataCache {
  getFileCache(file: TFile): CachedMetadata | null;
  /** The file a link points to, resolved like the vault's client does (Obsidian's rules). */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
  /** source path → (target path → number of links). */
  resolvedLinks: Record<string, Record<string, number>>;
  /**
   * The notes linking to `path` (source path → number of links): `resolvedLinks` read backwards.
   * Optional: a host that keeps backlinks answers without a pass over every link.
   */
  backlinksOf?(path: string): Record<string, number>;
  /** A link to `file` written from `sourcePath`, in the vault's link format. */
  fileToLinktext?(file: TFile, sourcePath: string, omitMdExtension?: boolean): string;
  on(name: "changed", cb: (file: TFile) => unknown): EventRef;
  on(name: "resolved", cb: () => unknown): EventRef;
  offref?(ref: EventRef): void;
}

export interface FileManager {
  /** Rename or move a file and update every link to it. */
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
  /** Edit a note's frontmatter as an object. */
  processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  trashFile?(file: TAbstractFile): Promise<void>;
  /**
   * Files moved outside `renameFile` (by hand: old path → new path, already moved on disk and in
   * the index): the notes whose links still point to an old path, each with its text now and the
   * text `renameFile` would have left (links resolved as the vault was before the move, rewritten
   * in the vault's link format). Nothing is written. A host without it repairs no links after a
   * hand move. A move whose old path holds a file again is followed only where
   * `options.reoccupied` says the link meant the file that moved away.
   */
  linksAfterMove?(moves: ReadonlyMap<string, string>, options?: LinksAfterMoveOptions): Promise<LinkRewrite[]>;
}

/** Options of `FileManager.linksAfterMove`. */
export interface LinksAfterMoveOptions {
  /**
   * A move whose old path holds another file again (a → b, then c → a): whether the links to that
   * path in the note `note` (its text now: `text`) meant the file that moved away. Without it,
   * such a move is left out.
   */
  reoccupied?: (from: string, note: string, text: string) => boolean;
}

/** What a host tells about a `rename` event (its third argument), when it knows. */
export interface RenameInfo {
  /**
   * Another program renamed the file (the host saw it on disk), not the engine: a hand edit, also
   * when it is seen while the engine writes.
   */
  external?: boolean;
}

/** A note's text before and after its links follow files that moved (see `FileManager.linksAfterMove`). */
export interface LinkRewrite {
  path: string;
  before: string;
  after: string;
}

/**
 * The engine's store: its own files (journal, transaction log, settings, tokens, logs), outside the
 * vault. Paths are relative to the store folder (`journal/2026-10.jsonl`; `""` is the folder itself).
 */
export type StoreAdapter = VaultAdapter;

/** A pack of rows as the host keeps it: its file, its table and key, the paths of its rows. */
export interface PackInfo {
  /** The pack's file (`family/babycare/milk_feed/milk_feed 2026-10.md`). */
  path: string;
  table: string;
  key: string;
  /** Its rows, by the path each would have as a note of its own (the vault lists them there). */
  rows: string[];
}

/**
 * Packs of rows (a table's `pack` option): one note holding many rows of a table, one `##`
 * section per row (pack-format.ts). The host lists each row of a pack as a note of its own, at
 * the path its values give it (its logical path): the engine reads, writes, links and deletes it
 * as any note, and never sees the pack's file. A host without packs leaves `App.packs` out, and
 * the `pack` option is refused.
 *
 * Packing and unpacking are silent: the rows keep their paths, their text and their stat (no
 * vault event, no change of `file_modified`).
 */
export interface PackStore {
  /** Whether `path` is the file of a pack. */
  isPack(path: string): boolean;
  /** The pack holding the row at `path` and the row's heading in it; null for a note of its own. */
  locate(path: string): { pack: string; heading: string } | null;
  /** The packs of a table (`catalog.schema.table`), by path. */
  packsOf(table: string): PackInfo[];
  /**
   * Put rows of `table` that are notes of their own (`rows`: their paths) into the pack of `key`
   * (made at `path` when there is none yet): each note's text becomes a section, and the note's
   * file goes. `tableKey`: the property that names a row's table. Returns the pack's path.
   */
  pack(input: { table: string; key: string; path: string; rows: readonly string[]; tableKey: string }): Promise<string>;
  /**
   * Take rows out of the pack at `pack` (`rows`: their paths; all when absent) as notes of their
   * own at their paths, with the text and the modification time they had in it; a pack left
   * without rows goes. Returns the rows' paths.
   */
  unpack(pack: string, rows?: readonly string[]): Promise<string[]>;
  /**
   * The notes whose links lead to `rows`, each with its text now and with those links rewritten:
   * `to: "pack"` (the rows go into packs; `targets` gives each its pack and heading) writes
   * `[[pack#row]]`, the form Obsidian follows too; `to: "note"` (they come out) writes the link to
   * the note. The notes among `rows` are left as they are. Nothing is written.
   */
  relinks(rows: readonly string[], to: "pack" | "note", targets: ReadonlyMap<string, { pack: string; heading: string }>): Promise<LinkRewrite[]>;
}

/** The environment the engine runs in. Named `App` so engine code reads like plugin code. */
export interface App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  /**
   * The engine's store (see store.ts). A host without one keeps it in the vault's `.datanotes/`
   * folder, through `vault.adapter`.
   */
  store?: StoreAdapter;
  /** Packs of rows (see {@link PackStore}); absent on a host without them (Obsidian). */
  packs?: PackStore;
}
