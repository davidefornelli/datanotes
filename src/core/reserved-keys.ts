/**
 * Keys of the engine's ordered table description (see `entryToOrdered` in metastore.ts) that
 * carry table metadata, not row fields: they are never columns, defaults or row values.
 */

import { COLUMNS_KEY, TABLE_KEY } from "./types-table";

export const TABLE_META_KEYS: readonly string[] = [TABLE_KEY, COLUMNS_KEY];
