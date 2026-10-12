/**
 * Settings for an engine a test starts, where the engine keeps them: in the database's store,
 * `<data home>/<id>/settings.json`. The metastore gets an id (a new one unless it has one), so the
 * store is known before the start; the data home is the tests' own (tests/setup.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { dataHome, readDatabaseId } from "../../src/api/local";
import { newDatabaseId, withMetastoreId } from "../../src/core/database-id";

/** Write `settings` into the store of the database at `metastore` (vault-relative); returns the store. */
export function seedStoreSettings(vault: string, settings: Record<string, unknown>, metastore = "datanotes/metastore.yaml"): string {
  const file = path.join(vault, ...metastore.split("/"));
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let id = readDatabaseId(text);
  if (!id) {
    id = newDatabaseId();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, withMetastoreId(text, id));
  }
  const store = path.join(dataHome(process.env), id);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "settings.json"), JSON.stringify(settings));
  return store;
}
