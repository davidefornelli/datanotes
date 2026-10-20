/**
 * What a named token may call without further checks, and what stays the owner's (`tokens.ts`
 * enforces them; `openapi.ts` documents which routes may answer 403). A module of its own so the
 * OpenAPI document does not import the registry.
 */

import { OPERATION_KIND, OPERATIONS } from "../api/catalog";

/** Operations that only read (their `readOnlyHint`): every token may call them. */
export const READ_OPERATIONS: ReadonlySet<string> = new Set(OPERATIONS.filter((o) => o.annotations.readOnlyHint === true).map((o) => o.name));

/** Operations that change the schema: a token needs `ddl`. */
export const SCHEMA_OPERATIONS: ReadonlySet<string> = new Set(Object.keys(OPERATION_KIND).filter((op) => OPERATION_KIND[op] === "schema"));

/** Row writes, and the arguments naming the tables they write: a token needs a matching `write` pattern. */
export const ROW_WRITES: Readonly<Record<string, readonly string[]>> = {
  insert_row: ["table"],
  update_row: ["table"],
  update_rows: ["table"],
  delete_rows: ["table"],
  move_rows: ["table", "to_table"],
  adopt_rows: ["table"],
  merge_rows: ["table"],
  recompute_columns: ["table"],
  align_relations: ["table"],
};

/** Operations only the owner calls, never a named token (even with `maintain`). */
export const OWNER_OPERATIONS: ReadonlySet<string> = new Set(["create_webhook", "delete_webhook"]);

/**
 * Routes besides the operations a token may always call: its own registry entry, the API's
 * description, the installed extensions, and what an MCP server reports (the agent's model, its tool calls, the docs search).
 */
export const READ_ROUTES = new Set(["/manual/search/", "/tokens/me/", "/tokens/update/", "/extensions/", "/openapi/", "/openapi.json/", "/sessions/identify/", "/tool-calls/record/"]);

/** Administration of the engine and its status: only with the owner's token, never a named one (even with `maintain`). */
export const OWNER_ADMIN_ROUTES = new Set(["/tokens/", "/tokens/create/", "/tokens/update/", "/tokens/delete/", "/tokens/rotate/", "/extensions/record/", "/extensions/delete/", "/status/", "/stop/"]);
