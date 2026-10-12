/**
 * Paths inside the database folder. The database is a subfolder of the folder the engine serves
 * (`datanotes/`, beside other notes: `datanotes serve --vault`), or that folder itself
 * (`datanotes serve --database`): then its folder is "" and its paths are the vault's own
 * (`main/public/film/Metropolis.md`, `metastore.yaml`).
 */

/** The database folder as written in the settings: no leading or trailing slash; "" is the root. */
export function normalizeDatabaseFolder(folder: string): string {
  return folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** `rel` inside the database folder `root` ("" for the root of the vault). */
export function inDatabase(root: string, rel: string): string {
  return root === "" ? rel : `${root}/${rel}`;
}

/** Is the vault path `p` the database folder itself or inside it? Every path is, when the database is the root. */
export function isInDatabase(root: string, p: string): boolean {
  return root === "" || p === root || p.startsWith(`${root}/`);
}

/** `p` relative to the database folder `root` (as given when it is outside). */
export function relativeToDatabase(root: string, p: string): string {
  return root === "" ? p : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

/**
 * A vault path after the database folder moved from `from` to `to`. A folder moves with what is
 * inside it; the root ("") does not move as a whole: only its database `entries` move (the catalog
 * folders and metastore.yaml, see {@link databaseEntries}), and the notes beside them stay.
 */
export function movePath(path: string, from: string, to: string, entries: readonly string[] = []): string {
  if (from === "") return entries.includes(path.split("/")[0]!) ? inDatabase(to, path) : path;
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? inDatabase(to, path.slice(from.length + 1)) : path;
}

/** What a database at the root of the vault is made of there: metastore.yaml and its catalog folders. */
export function databaseEntries(metastoreFile: string, catalogs: Iterable<string>): string[] {
  return [metastoreFile, ...catalogs].sort();
}
