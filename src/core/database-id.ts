/**
 * The database's id: a UUID at the top of `metastore.yaml` (`id: 0192…`). The engine writes it
 * when it creates the database (or, for a metastore without one, once at the first start) and no
 * operation changes it afterwards (`datanotes store new-id` gives a copied database a new one).
 * The headless host finds the database's store by it: `<data home>/<id>/`.
 */

import { isUuid, uuidv7 } from "./uuid";

export const DATABASE_ID_KEY = "id";

/** A top-level `id:` line (no indentation). */
const ID_LINE = /^id:[ \t]*(.*)$/m;

/** A new database id (UUID v7: it sorts by creation time). */
export function newDatabaseId(nowMs?: number): string {
  return uuidv7(nowMs);
}

/** The id of a metastore text, or null (none, or not a UUID). Read without parsing the whole file. */
export function metastoreId(text: string): string | null {
  const m = ID_LINE.exec(text);
  const value = m ? m[1]!.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "") : "";
  return isUuid(value) ? value.toLowerCase() : null;
}

/**
 * The text with `id` set: the top-level `id:` line replaced, or one added at the top (after the
 * leading comments). The rest of the file is kept byte for byte.
 */
export function withMetastoreId(text: string, id: string): string {
  if (ID_LINE.test(text)) return text.replace(ID_LINE, `${DATABASE_ID_KEY}: ${id}`);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^#/.test(lines[i]!)) i++;
  const rest = lines.slice(i).join("\n");
  const body = rest.trim() === "{}" ? "" : rest.replace(/^\n+/, "");
  return [...lines.slice(0, i), `${DATABASE_ID_KEY}: ${id}`, body].join("\n");
}
