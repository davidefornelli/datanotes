/**
 * OpenAPI 3.1 description of the HTTP API (`GET /datanotes/openapi.json`, public; browsed at
 * `GET /datanotes/docs`), generated from the catalogue of operations (`src/api/`): each operation
 * is `POST /datanotes/operations/<name>/`, its arguments (`inputSchema`) the request body and its
 * result (`responseSchema`) the 200 body. Schemas with a `title` become `components.schemas`.
 *
 * The other routes (status, stop, tokens, sessions, tool calls, the change feed's stream, the docs)
 * are described here by hand. The error statuses are those the server really answers:
 * - 400 bad input (`{error}`): every `/datanotes/*` POST (a body that is not a JSON object, an
 *   unknown, missing or wrongly typed argument);
 * - 401 missing or wrong token (`{error}`): every route but `GET /`, the spec and the docs;
 * - 403 (`{error}`): a named token beyond its permissions (writes, schema changes, maintenance; `token-routes.ts`),
 *   or a read of a table or note outside its `read` patterns (every operation that reads; `read-scope.ts`);
 * - 404 (`{error}`): unknown table, view or migration, where the operation names one; a missing note or folder;
 * - 409: an ambiguous table name (`{error, paths}` / `{error, tables}`), or an undo refused
 *   (OpResult with `ok: false`);
 * - 422: a write refused by validation or conflicts, nothing written (OpResult / batch result
 *   with `ok: false`);
 * - 500: an unexpected error (`{error}`), or a write that failed partway and could not be rolled
 *   back (OpResult with `rolled_back: false`; `failed` lists the files left);
 * - 503: a write that failed partway and was rolled back, nothing written (OpResult with
 *   `rolled_back: true`: send it again later), or (`{error}`) any request that comes while the
 *   engine stops (`/stop/`).
 */

import { OPERATION_KIND, OPERATION_KINDS, OPERATIONS, type OperationDef, type OperationKind } from "../api/catalog";
import { operationRoute } from "../api/requests";
import { READ_OPERATIONS, READ_ROUTES } from "./token-routes";
import { operationOf, ROUTE_PREFIX } from "./rest";

type Schema = Record<string, unknown>;

const json = (schema: Schema) => ({ "application/json": { schema } });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** The operation's 2xx body (a field another part of the catalogue may not define yet). */
function responseSchemaOf(op: OperationDef | undefined): Schema | undefined {
  return (op as { responseSchema?: Schema } | undefined)?.responseSchema;
}

/** Keywords whose values are data, not schemas: never searched for titles. */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples", "example"]);

/**
 * Moves every sub-schema with a `title` into `components` (keyed by the title, made a valid
 * component name) and replaces it with a `$ref`. The first schema of a title wins.
 */
function hoist(schema: unknown, components: Record<string, Schema>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => hoist(s, components));
  if (!schema || typeof schema !== "object") return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema as Schema)) out[k] = DATA_KEYWORDS.has(k) ? v : hoist(v, components);
  if (typeof out.title === "string" && typeof out.$ref !== "string") {
    const name = out.title.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (!components[name]) components[name] = out;
    return ref(name);
  }
  return out;
}

/** The status of a refused write (`rest.ts`): 422 for the writes that validate rows and the schema, 409 for undo. */
function refusedStatus(op: string): number | undefined {
  if (op === "undo_migration") return 409;
  const kind = OPERATION_KIND[op];
  return kind === "schema" || kind === "rows" || op === "restore_table" || op === "restore_database" ? 422 : undefined;
}

/** Arguments that name a table, view or migration: the operation may answer 404 / 409. */
const NAMES_A_TABLE = ["table", "source", "target", "to_table", "view", "migration_id", "from_nodes", "to_nodes", "operations"];

/** Operations that name a note or folder of the vault: 404 when it is missing. */
const NAMES_A_PATH = new Set(["read_note", "list_folder"]);

/** The routes besides the operations, by tag. */
const ROUTE_TAGS: { name: string; description: string; match: (route: string) => boolean }[] = [
  { name: "change feed", description: "The change feed as Server-Sent Events, and the tool calls MCP servers report.", match: (r) => /^\/(changes|tool-calls)\b/.test(r) },
  { name: "tokens", description: "Named tokens and their permissions; what MCP servers report about their agents' sessions.", match: (r) => /^\/(tokens|sessions)\//.test(r) },
  { name: "extensions", description: "The extensions installed in the database: their versions, tables, tools and tokens.", match: (r) => /^\/extensions\//.test(r) },
  { name: "service", description: "Status, stop, this document, the interactive console, the docs.", match: () => true },
];

/** An operation's tag: its kind (the docs' reference groups them the same way). */
const kindTag = (kind: OperationKind) => OPERATION_KINDS[kind].label;

const tagOf = (route: string) => {
  const op = operationOf(route);
  /* v8 ignore next -- catalog data: every operation has a kind */
  return op !== undefined ? kindTag(OPERATION_KIND[op] ?? "auxiliary") : ROUTE_TAGS.find((t) => t.match(route))!.name;
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad input: the body is not a JSON object, or an argument is unknown, missing or of the wrong type.",
  403: "A named token beyond its permissions (the engine's administration, tables outside its `write` patterns, schema changes without `ddl`).",
  404: "Unknown table, view, migration, note or folder.",
  409: "Ambiguous table name: it matches several tables (`paths` or `tables` lists them).",
};

/** 403 of a read operation: only when it names a table, view or note outside the token's `read` patterns. */
const READ_DENIED_TEXT =
  "A named token whose `read` patterns do not cover the table, view or note the request names (such as `token cook may not read personal.health.weight`). Sets it did not name (listings, bases, search, the graph, the change feed) are filtered instead.";

const ERRORS = {
  400: { description: STATUS_TEXT[400], content: json(ref("Error")) },
  401: { $ref: "#/components/responses/Unauthorized" },
  403: { description: STATUS_TEXT[403], content: json(ref("Error")) },
  readDenied: { description: READ_DENIED_TEXT, content: json(ref("Error")) },
  404: { description: STATUS_TEXT[404], content: json(ref("Error")) },
  409: { description: STATUS_TEXT[409], content: json(ref("AmbiguousName")) },
  500: { $ref: "#/components/responses/ServerError" },
};

interface RouteDoc {
  route: string;
  operationId: string;
  summary: string;
  description?: string;
  body?: Schema;
  bodyRequired?: boolean;
  /** 200 body (hoisted already). */
  result: Schema;
  resultText?: string;
  namesTable?: boolean;
  writes?: boolean;
  extra?: Schema;
  /** When the route may answer 503: why. */
  unavailable?: string;
}

/** A `POST /datanotes/<route>` operation with the responses it can really give. */
function postRoute(d: RouteDoc): Schema {
  const responses: Record<string, unknown> = { "200": { description: d.resultText ?? "Done.", content: json(d.result) }, "400": ERRORS[400], "401": ERRORS[401] };
  const op = operationOf(d.route);
  const read = op !== undefined ? READ_OPERATIONS.has(op) : READ_ROUTES.has(d.route) && d.route !== "/tokens/update/";
  if (!read) responses["403"] = ERRORS[403];
  else if (op !== undefined) responses["403"] = ERRORS.readDenied;
  if (d.namesTable) responses["404"] = ERRORS[404];
  const refused = op !== undefined ? refusedStatus(op) : undefined;
  if (refused === 409) {
    responses["409"] = { description: "Undo refused (later changes depend on it, or it was undone already): nothing written (a batch is checked as a whole first; when one of its operations then finds a note changed since, the operations after it stay reverted: `touched`, and a retry skips them). Same body as 200, with `ok: false`.", content: json({ anyOf: [d.result, ref("AmbiguousName")] }) };
  } else if (d.namesTable) responses["409"] = ERRORS[409];
  if (refused === 422) {
    responses["422"] = { description: "Refused (validation failures, conflicts, an unmet `expect`): nothing written. Same body as 200, with `ok: false` and the reasons.", content: json(d.result) };
  }
  responses["500"] = refused
    ? { description: "Unexpected error (`{error}`), or a write that failed partway and could not be rolled back: `rolled_back: false`, `failed` lists the files left (undo_migration on `migration_id` retries the rollback).", content: json({ anyOf: [d.result, ref("Error")] }) }
    : ERRORS[500];
  if (refused === 422) {
    responses["503"] = { description: "A write that failed partway (a file another program holds) and was rolled back: `rolled_back: true`, nothing written. Send it again later. Same body as 200, with `ok: false` and `failed`.", content: json(d.result) };
  }
  if (d.unavailable) responses["503"] = { description: d.unavailable, content: json(ref("Error")) };
  return {
    post: {
      tags: [tagOf(d.route)],
      operationId: d.operationId,
      summary: d.summary,
      ...(d.description ? { description: d.description } : {}),
      ...(d.writes ? { parameters: [{ $ref: "#/components/parameters/Actor" }] } : {}),
      requestBody: { required: d.bodyRequired ?? false, content: json(d.body ?? { type: "object" }) },
      responses,
      ...(d.extra ?? {}),
    },
  };
}

const TOKEN = { $ref: "#/components/schemas/Token" };
const TOKEN_SECRET = { type: "string", description: "The token itself: shown once, stored hashed." };

const TOKEN_ROUTES: Record<string, { summary: string; body: Schema; result: Schema; writes?: boolean }> = {
  "/tokens/": { summary: "List the named tokens (owner only).", body: { type: "object" }, result: { type: "object", properties: { tokens: { type: "array", items: TOKEN } } } },
  "/tokens/me/": { summary: "The calling token's own entry (a named token; 400 for the owner).", body: { type: "object" }, result: { type: "object", properties: { entry: { oneOf: [TOKEN, { type: "null" }] } } } },
  "/tokens/create/": {
    summary: "Create a named token (owner only). Returns the token once.",
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "Kebab-case; the journal records it as `auth`. `owner` is reserved." },
        description: { type: "string" },
        read: { type: "array", items: { type: "string" }, description: "Tables the token may read, as patterns like `write`'s. Absent (or with `*`): every table. It must cover every `write` pattern, and stay absent with `ddl` or `maintain` (400 otherwise)." },
        write: { type: "array", items: { type: "string" }, description: "Tables the token may write: catalog.schema.table, catalog.schema.*, catalog.* or *." },
        ddl: { type: "boolean", description: "May the token change the schema?" },
        maintain: { type: "boolean", description: "May the token also undo, restore, vacuum, configure and rebuild the semantic index? (For an agent's own token.)" },
        autolink: { type: "boolean", description: "Automatic links of the token's writes that pass no `autolink`: false for a sync program's token. Absent: the database's `autolink` setting." },
      },
    },
    result: { type: "object", properties: { entry: TOKEN, token: TOKEN_SECRET } },
    writes: true,
  },
  "/tokens/update/": {
    summary: "Change a named token. A token may change its own description and autolink default; permissions (`read`, `write`, `ddl`, `maintain`) are the owner's.",
    body: {
      type: "object",
      properties: {
        name: { type: "string", description: "Owner only (a named token updates itself)." },
        description: { type: "string", description: "An empty string removes it." },
        read: { type: ["array", "null"], items: { type: "string" }, description: "The tables the token may read; null reads every table again. Checked against `write`, `ddl` and `maintain` as on create." },
        write: { type: "array", items: { type: "string" } },
        ddl: { type: "boolean" },
        maintain: { type: "boolean" },
        autolink: { type: ["boolean", "null"], description: "The default of the token's writes for automatic links; null follows the database's setting again." },
      },
    },
    result: { type: "object", properties: { entry: TOKEN } },
    writes: true,
  },
  "/tokens/delete/": { summary: "Revoke a named token (owner only): it stops working at once.", body: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, result: { type: "object", properties: { deleted: { type: "boolean" } } }, writes: true },
  "/tokens/rotate/": { summary: "Give a named token a new value (owner only): the old one stops working.", body: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, result: { type: "object", properties: { token: TOKEN_SECRET } }, writes: true },
};

const EXTENSION = { $ref: "#/components/schemas/InstalledExtension" };

const EXTENSION_ROUTES: Record<string, { summary: string; body: Schema; result: Schema; writes?: boolean }> = {
  "/extensions/": {
    summary: "The extensions installed in the database, and its id (any token).",
    body: { type: "object" },
    result: { type: "object", properties: { database_id: { type: ["string", "null"] }, extensions: { type: "array", items: EXTENSION } } },
  },
  "/extensions/record/": {
    summary: "Record an installed extension (owner only): what datanotes extension install writes.",
    body: EXTENSION,
    result: { type: "object", properties: { extension: EXTENSION } },
    writes: true,
  },
  "/extensions/delete/": {
    summary: "Forget an installed extension (owner only): what datanotes extension remove does.",
    body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    result: { type: "object", properties: { deleted: { type: "boolean" } } },
    writes: true,
  },
};

const str = { type: "string" };
const int = { type: "integer" };
const strOrNull = { type: ["string", "null"] };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", required, properties });

/** The `/status/` report (`status.ts`). */
const ENGINE_STATUS: Schema = {
  ...obj({
    healthy: { type: "boolean", description: "False when something needs attention (`problems`)." },
    problems: { type: "array", items: str, description: "What needs attention, in words: git sync blocked, the store backup failing, a webhook failing, the change feed not running, hand edits breaking the tables' rules, metastore.yaml unreadable." },
    engine: obj({
      version: str,
      pid: { type: ["integer", "null"] },
      host_name: strOrNull,
      started_at: str,
      uptime_s: int,
      http: obj({ host: str, port: { type: ["integer", "null"] } }),
      watch: { type: ["string", "null"], description: "How the service sees file changes: events or poll." },
      vault: strOrNull,
      settings_file: strOrNull,
      store: { type: ["string", "null"], description: "The engine's store folder: settings, tokens, journal, transaction log, change feed, logs." },
      database_id: { type: ["string", "null"], description: "The database's id (`id` in metastore.yaml); its store is found by it." },
      database_folder: str,
    }),
    database: obj(
      {
        metastore: str,
        moved: {
          ...obj({ from: str, to: str, at: str, by: { type: "string", enum: ["configure_database", "hand"] } }),
          description: "The last move of the database folder: by configure_database, or by hand (found again by its id).",
        },
        readable: { type: "boolean" },
        error: { type: "string", description: "Why metastore.yaml is not readable: not found, or the parse error." },
        tables: int,
        views: int,
        history_tables: { type: "integer", description: "Tables keeping a transaction log (history on)." },
        journal: obj({
          window_hours: int,
          operations: { type: "integer", description: "Operations journaled in the window." },
          last: {
            anyOf: [obj({ migration_id: str, op: str, summary: str, executed_at: str, by: { type: "string", description: "harness / model of the agent." } }, ["migration_id", "op", "summary", "executed_at"]), { type: "null" }],
          },
        }),
      },
      ["metastore", "readable", "tables", "views", "history_tables", "journal"],
    ),
    git_sync: {
      description: "Null when the service runs without --git-sync.",
      anyOf: [
        obj(
          { enabled: { type: "boolean" }, repo: str, last_run_at: str, last_commit: str, last_push_at: str, blocked: { type: "string", description: "Why the sync stopped (a pull conflict…), until a good cycle." }, pending_operations: int },
          ["enabled", "pending_operations"],
        ),
        { type: "null" },
      ],
    },
    store_backup: {
      description: "The store's git backup (journal, transaction logs, change feed, token hashes); null when it is off.",
      anyOf: [
        obj(
          {
            enabled: { type: "boolean" },
            interval_s: { description: "The seconds between two looks for changes: when something changed, a commit between two operations, then a push.", type: "integer" },
            remote: { type: ["string", "null"], description: "The remote, without credentials; null: commits in the store only." },
            last_commit: str,
            last_commit_at: str,
            last_push_at: str,
            pending_operations: { type: "integer", description: "Operations not committed yet." },
            pending_commits: { type: "integer", description: "Commits not pushed yet." },
            last_error: { type: "string", description: "The last failure (a push refused, git missing), until a good push." },
            next_retry_at: { type: "string", description: "When a failing push is tried again." },
            hint: { type: "string", description: "How to fix last_error, when a person must (a file too large to push)." },
            docs: { type: "string", description: "Where to read more about last_error." },
          },
          ["enabled", "interval_s", "remote", "pending_operations", "pending_commits"],
        ),
        { type: "null" },
      ],
    },
    change_feed: obj({ running: { type: "boolean" }, reason: { type: "string", description: "Why it is not running." }, head: { type: ["integer", "null"], description: "The newest sequence number, as list_changes answers it." } }, ["running", "head"]),
    webhooks: obj({
      count: int,
      failing: {
        type: "array",
        items: obj({ id: str, url_host: { type: "string", description: "The URL's host only." }, failures: { type: "integer", description: "Failed attempts in a row (retried with backoff)." }, last_error: str, last_delivery: str, cursor: int }, ["id", "url_host", "failures", "cursor"]),
      },
    }),
    tokens: { type: "array", description: "The named tokens (never their values).", items: obj({ name: str, write: { type: "array", items: str }, ddl: { type: "boolean" }, maintain: { type: "boolean" }, last_seen: strOrNull }) },
    hand_edits: obj(
      {
        window_hours: int,
        checked: { type: "boolean" },
        reason: { type: "string", description: "Why they were not looked at." },
        edits: { type: "integer", description: "Hand edits the change feed recorded in the window." },
        rows: { type: "integer", description: "Rows whose latest change in the window is a hand edit that breaks the tables' rules." },
        violations: int,
        latest: { type: "array", items: obj({ path: str, table: strOrNull, at: str, seq: int, violations: int, message: str }) },
      },
      ["window_hours", "checked"],
    ),
    logs: obj({ folder: { type: ["string", "null"], description: "Log files in the store (fileLogEnabled)." }, console_log: { type: ["string", "null"], description: "`--log` file." }, telemetry: { type: ["string", "null"], description: "Origin of the OTLP collector." } }),
  }),
  description: "The engine's health (`datanotes status`). Never a token or a secret.",
};

const SCHEMAS: Record<string, Schema> = {
  EngineStatus: ENGINE_STATUS,
  Error: { type: "object", required: ["error"], properties: { error: { type: "string", description: "What went wrong, for a person or an agent." } } },
  AmbiguousName: {
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      paths: { type: "array", items: { type: "string" }, description: "The tables' folders the name matches." },
      tables: { type: "array", items: { type: "string" }, description: "The qualified tables the name matches." },
    },
  },
  DocsSemanticResults: {
    type: "object",
    required: ["query", "version", "ready", "sections", "embedded", "results"],
    properties: {
      query: { type: "string" },
      version: { type: "string", description: "The version of the docs the engine ships: a hash of their sections. `search_docs` fuses the results only when its own docs have the same." },
      ready: { type: "boolean", description: "The index covers every section of that version; false while the engine builds it, with no results." },
      sections: { type: "integer", description: "The sections of the docs." },
      embedded: { type: "integer", description: "The sections that have their vector." },
      results: {
        type: "array",
        description: "The sections closest in meaning first.",
        items: {
          type: "object",
          required: ["path", "score"],
          properties: {
            path: { type: "string", description: "The section, as `read_docs` reads it: `guides/history/restore#time-travel-and-restore-the-whole-database`." },
            score: { type: "number", description: "Cosine similarity, -1 to 1." },
          },
        },
      },
      last_error: { type: "string", description: "Why the last build of the index failed, while it is not ready." },
    },
  },
  Token: {
    type: "object",
    description: "A named token as the registry shows it (never its value).",
    required: ["name", "write", "read", "ddl", "created_at", "updated_at"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      write: { type: "array", items: { type: "string" } },
      read: { type: "array", items: { type: "string" }, description: "The tables it may read (patterns like `write`'s); `[\"*\"]` when it reads every table." },
      ddl: { type: "boolean" },
      maintain: { type: "boolean" },
      autolink: { type: "boolean", description: "The default of its writes for automatic links (absent: the database's setting)." },
      created_at: { type: "string" },
      updated_at: { type: "string" },
      last_seen: { type: "string", description: "The last request made with it (saved within a minute)." },
    },
  },
  InstalledExtension: {
    type: "object",
    description: "An installed extension as the registry keeps it (datanotes extension install writes it).",
    required: ["name", "version", "description", "api", "source", "commit", "manifest_sha256", "entry_sha256", "token", "tables", "tools", "write", "migration_id", "installed_at", "updated_at", "previous"],
    properties: {
      name: { type: "string", description: "2 to 40 lowercase letters, digits or -, starting with a letter." },
      version: { type: "string" },
      description: { type: "string" },
      api: { type: "integer", description: "The module API version the extension's entry file exports." },
      source: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["git", "local"] },
          url: { type: "string", description: "git: the URL as given." },
          ref: { type: "string", description: "git: the tag or commit id given (or the newest tag chosen)." },
          path: { type: "string", description: "local: the absolute folder, with / separators." },
        },
      },
      commit: { type: "string", description: "The git commit id (40 hex), or local-<12 hex> for a folder." },
      manifest_sha256: { type: "string" },
      entry_sha256: { type: "string" },
      token: { type: "string", description: "The extension's named token: ext-<name>." },
      tables: {
        type: "object",
        description: "Each role of the manifest, bound to a qualified table.",
        additionalProperties: {
          type: "object",
          required: ["table", "owned"],
          properties: {
            table: { type: "string", description: "The qualified table bound to the role." },
            owned: { type: "boolean", description: "True for a role the extension owns." },
            columns: { type: "object", additionalProperties: { type: "string" }, description: "Dependency roles: manifest column to the user's column, only where they differ." },
            absent: { type: "array", items: { type: "string" }, description: "Dependency roles: optional manifest columns the bound table does not have." },
          },
        },
      },
      tools: { type: "array", items: { type: "string" } },
      write: { type: "array", items: { type: "string" }, description: "The token's write patterns (qualified table names)." },
      migration_id: { type: ["string", "null"], description: "The batch that brought the database from `previous` to this record." },
      installed_at: { type: "string" },
      updated_at: { type: "string" },
      previous: { anyOf: [{ $ref: "#/components/schemas/InstalledExtension" }, { type: "null" }], description: "The record before the last install, repair or update; null after a first install." },
    },
  },
};

const ok = { type: "object", properties: { ok: { type: "boolean", const: true } } };

export function openApiDocument(version: string): Schema {
  const components: Record<string, Schema> = { ...SCHEMAS };
  const paths: Record<string, Schema> = {};
  const byName = new Map(OPERATIONS.map((o) => [o.name, o]));
  const resultOf = (name: string): Schema | undefined => {
    const s = responseSchemaOf(byName.get(name));
    /* v8 ignore next -- catalog data: every operation has a response schema */
    return s ? (hoist(s, components) as Schema) : undefined;
  };

  for (const t of OPERATIONS) {
    const route = operationRoute(t.name);
    /* v8 ignore next -- catalog data: every operation input schema lists its arguments */
    const names = Object.keys(((t.inputSchema as Schema).properties ?? {}) as Schema);
    paths[`${ROUTE_PREFIX}${route}`] = postRoute({
      route,
      operationId: t.name,
      summary: t.description.split("\n")[0]!,
      description: t.description,
      body: t.inputSchema,
      bodyRequired: ((t.inputSchema as Schema).required as string[] | undefined)?.length ? true : false,
      /* v8 ignore next -- catalog data: every operation has a response schema */
      result: resultOf(t.name) ?? { type: "object" },
      namesTable: names.some((n) => NAMES_A_TABLE.includes(n)) || NAMES_A_PATH.has(t.name),
      writes: t.annotations.readOnlyHint !== true,
      extra: { "x-mcp-tool": t.name },
    });
  }

  // routes of the server that no catalogue operation names
  const extra: RouteDoc[] = [
    {
      route: "/manual/search/",
      operationId: "semantic_search_docs",
      summary: "The sections of the docs of this version closest in meaning to a query: what `search_docs` fuses with its ranking by words (hybrid search).",
      description:
        "The engine embeds every section of the docs it ships with the provider of semantic search, in an index of its own (`semantic/docs.json` in its store), rebuilt when the docs change. " +
        "It builds the index in the background, after it starts and when a search finds it out of date: until the index covers the docs, the answer has `ready: false` and no results. " +
        "400 when semantic search is off.",
      body: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The words to rank the sections by, such as `time travel a view`." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "The most sections to return." },
        },
      },
      bodyRequired: true,
      result: ref("DocsSemanticResults"),
      unavailable: "The docs are not in this installation (a checkout where they were not built).",
    },
    {
      route: "/sessions/identify/",
      operationId: "identify_session",
      summary: "Tell the engine the model and harness behind an agent session (what an MCP server reports): later requests carrying that session in `X-Datanotes-Actor` are journaled with it. Any token may call it.",
      body: { type: "object", required: ["session"], properties: { session: { type: "string" }, model: { type: "string" }, harness: { type: "string" } } },
      bodyRequired: true,
      result: ok,
    },
    {
      route: "/tool-calls/record/",
      operationId: "record_tool_call",
      summary: "Record an agent's tool call in the change feed (`tool_call` events): what an MCP server reports after each call, its own tools included (`served_by`). Any token may call it.",
      body: {
        type: "object",
        required: ["tool"],
        properties: {
          tool: { type: "string" },
          args: { type: "object" },
          ok: { type: "boolean" },
          duration_ms: { type: "number" },
          value: {},
          served_by: { type: "string" },
          session: { type: "string" },
          result_chars: { type: "number" },
          result_tokens: { type: "number" },
          summary: { type: "object", description: "The result's summary, when `value` is sent already cut: the engine records it (the answer says `takes_summary`)." },
        },
      },
      bodyRequired: true,
      result: {
        type: "object",
        properties: {
          ok: { type: "boolean", const: true },
          takes_summary: { type: "boolean", description: "The engine records a `value` sent cut with its `summary`: a reporter may send them so." },
        },
      },
      writes: true,
    },
    {
      route: "/status/",
      operationId: "engine_status",
      summary: "The engine's health at a glance (owner only; `datanotes status` prints it): engine, database, journal, git sync, change feed, webhooks, named tokens, hand edits breaking the rules in the last 24 h, logs.",
      description: "Reads what the engine already knows (nothing is checked again): hand edits are judged by the checks the change feed recorded with them. `healthy` is false when `problems` lists something. A named token is refused (403), even with `maintain`.",
      result: ref("EngineStatus"),
    },
    {
      route: "/stop/",
      operationId: "stop_engine",
      summary: "Stop the engine gracefully (owner only; `datanotes stop` calls it): it answers at once, then finishes the requests under way, makes the last git sync and store backup commit and push, releases its lock and exits.",
      description:
        "From the answer on, new requests get 503 (the engine is stopping) and long polls of the change feed answer at once. The engine waits for the requests under way for up to 30 s. Then it makes the vault's last git sync and the store backup's last commit and push, releases the lock and exits. The caller learns the end from the process (`datanotes stop` waits for it) or from `GET /`, which stops answering. A named token is refused (403), even with `maintain`. A host that cannot stop on request does not serve the route (404).",
      result: { type: "object", required: ["ok", "stopping", "pid"], properties: { ok: { type: "boolean", const: true }, stopping: { type: "boolean", const: true }, pid: { type: ["integer", "null"], description: "The engine's process." } } },
    },
    {
      route: "/openapi/",
      operationId: "openapi_post",
      summary: "This document (as `GET /datanotes/openapi.json`, with a token).",
      result: { type: "object" },
    },
  ];
  for (const d of extra) paths[`${ROUTE_PREFIX}${d.route}`] = postRoute(d);
  for (const [route, r] of Object.entries(TOKEN_ROUTES)) {
    paths[`${ROUTE_PREFIX}${route}`] = postRoute({ route, operationId: `tokens_${route.split("/").filter(Boolean).slice(1).join("_") || "list"}`, summary: r.summary, body: r.body, result: r.result, writes: r.writes ?? false });
  }

  for (const [route, r] of Object.entries(EXTENSION_ROUTES)) {
    paths[`${ROUTE_PREFIX}${route}`] = postRoute({ route, operationId: `extensions_${route.split("/").filter(Boolean).slice(1).join("_") || "list"}`, summary: r.summary, body: r.body, result: r.result, writes: r.writes ?? false });
  }

  paths[`${ROUTE_PREFIX}/changes/stream`] = {
    get: {
      tags: [tagOf("/changes/stream")],
      operationId: "changes_stream",
      summary: "The change feed as Server-Sent Events (id = sequence number). Resumes from Last-Event-ID or `since`.",
      description: "Same filters as list_changes (`tables`, `kinds`, `columns`: comma-separated; `exclude_actor`; `where`: JSON). A comment line every 25 s keeps proxies from closing the connection; `event: gap` tells the client events were pruned.",
      parameters: [
        ...["since", "tables", "kinds", "columns", "exclude_actor", "where"].map((n) => ({ name: n, in: "query", required: false, schema: { type: "string" } })),
        { name: "Last-Event-ID", in: "header", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "The events, one `data:` line (JSON) each.", content: { "text/event-stream": { schema: { type: "string" } } } },
        "400": { description: "`where` is not a JSON object.", content: json(ref("Error")) },
        "401": ERRORS[401],
        "503": { description: "The change feed is not running.", content: json(ref("Error")) },
      },
    },
  };

  // public routes
  paths["/"] = {
    get: {
      tags: ["service"],
      operationId: "status",
      summary: "Status and version (no token needed; `authenticated` tells whether the token sent is accepted, `auth` whose it is).",
      security: [],
      responses: {
        "200": {
          description: "Running.",
          content: json({
            type: "object",
            properties: {
              status: { type: "string", const: "OK" },
              service: { type: "string", const: "datanotes" },
              version: { type: "string" },
              authenticated: { type: "boolean", description: "True when the request sent an accepted token: the owner's or a named one." },
              auth: { type: ["string", "null"], description: "Whose token was sent: \"owner\", or the named token's name; null without an accepted token." },
            },
          }),
        },
      },
    },
  };
  paths[`${ROUTE_PREFIX}/openapi.json`] = {
    get: { tags: ["service"], operationId: "openapi", summary: "This document (public: it describes the API, it holds no data).", security: [], responses: { "200": { description: "OpenAPI 3.1.", content: json({ type: "object" }) } } },
  };
  paths[`${ROUTE_PREFIX}/docs`] = {
    get: {
      tags: ["service"],
      operationId: "docs",
      summary: "This document in an interactive console (Swagger UI, served by the engine; public). Authorize with a token to try the routes.",
      security: [],
      responses: { "200": { description: "HTML page.", content: { "text/html": { schema: { type: "string" } } } } },
    },
  };

  // the docs of this version, shipped with the package (src/api/docs.ts)
  const markdown = (description: string) => ({ description, content: { "text/markdown": { schema: { type: "string" } } } });
  const noDocs = { description: "The docs are not in this installation (a checkout where they were not built).", content: json(ref("Error")) };
  paths[`${ROUTE_PREFIX}/manual/`] = {
    get: {
      tags: ["service"],
      operationId: "manual_index",
      summary: "The index of the docs of this version (every page of datanotes.dev as Markdown, shipped with the package): each page with its description and route.",
      responses: { "200": markdown("The index, in Markdown."), "401": ERRORS[401], "503": noDocs, "500": ERRORS[500] },
    },
  };
  paths[`${ROUTE_PREFIX}/manual/{page}.md`] = {
    get: {
      tags: ["service"],
      operationId: "manual_page",
      summary: "A page of the docs of this version as Markdown, or one of its sections with `section`, the anchor of its heading. The same text as the page with `.md` on datanotes.dev, offline.",
      parameters: [
        { name: "page", in: "path", required: true, description: "The page's path on the site, such as `guides/read-and-write/read-and-filter` (its `/` as is, or URL-encoded as %2F).", schema: { type: "string" } },
        { name: "section", in: "query", required: false, description: "The anchor of a section, such as `compare-values-with-operators`: only that section, with its subsections.", schema: { type: "string" } },
      ],
      responses: {
        "200": markdown("The page or section."),
        "401": ERRORS[401],
        "404": { description: "No such page or section: `hint` names the closest ones.", content: json(ref("Error")) },
        "503": noDocs,
        "500": ERRORS[500],
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Datanotes",
      version,
      description:
        "Database of Markdown notes: tables of notes, rows, queries, history, a change feed and the vault's notes.\n\n" +
        "**Operations**: every operation is `POST /datanotes/operations/<name>/`, its body the operation's arguments (the same names as the MCP tool of the same name). An unknown argument is refused (400) with the closest real one.\n\n" +
        "**Authentication**: every route but `GET /`, this document and `/datanotes/docs` needs `Authorization: Bearer <token>`: " +
        "the owner's token (`httpServerToken` in the settings: everything) or a named token (`/datanotes/tokens/create/`: reads the tables in its `read` patterns, every table without them; writes the tables in its `write` patterns, " +
        "changes the schema with `ddl`; the engine's administration stays the owner's: 403 otherwise).\n\n" +
        "**Actor**: send `X-Datanotes-Actor: {\"harness\": …, \"model\": …, \"session\": …}` (JSON) to record on whose behalf a write is made; " +
        "the journal adds the credential (`auth`: `owner`, or the named token's name), which the client cannot claim.\n\n" +
        "**Errors**: `{error}` with 400 (bad input), 401 (missing or wrong token), 403 (a named token beyond its permissions, or a read of a table outside its `read` patterns), 404 (unknown table, view, migration or note), " +
        "409 (ambiguous table name), 500. A refused write answers 422 (409 for undo) with the operation's result, `ok: false`: nothing was written.",
    },
    servers: [{ url: "/" }],
    tags: [
      ...(Object.keys(OPERATION_KINDS) as OperationKind[]).map((k) => ({ name: kindTag(k), description: OPERATION_KINDS[k].description })),
      ...ROUTE_TAGS.map(({ name, description }) => ({ name, description })),
    ],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "The owner's token or a named token." } },
      parameters: {
        Actor: {
          name: "X-Datanotes-Actor",
          in: "header",
          required: false,
          description: "JSON: on whose behalf the write is made, recorded in the journal (`harness`, `model`, `session`).",
          schema: { type: "string" },
          example: '{"harness":"my-script","model":"","session":"s-1"}',
        },
      },
      responses: {
        Unauthorized: { description: "Missing or wrong bearer token.", content: json(ref("Error")) },
        ServerError: { description: "Unexpected error.", content: json(ref("Error")) },
      },
      schemas: components,
    },
    security: [{ bearer: [] }],
    paths,
  };
}
