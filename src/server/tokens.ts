/**
 * Named tokens: each program or agent gets its own token, with its permissions and a name the
 * journal records (docs: guides/security/tokens).
 *
 * The registry lives in the engine's store (`store:tokens.json`). Each entry keeps the token's
 * SHA-256 (never the token), its permissions (`write`: table patterns it may write; `ddl`;
 * `maintain`) and when it was last seen. Requests made with a named token carry its name as the
 * actor's `auth` (the owner's token: `"owner"`), so the journal says which token wrote, on behalf
 * of which agent.
 */

import { currentActor, type Actor } from "../core/actor";
import type { App } from "../core/host";
import { loadMetastore, rowTableFull } from "../core/metastore";
import type { DatanotesSettings } from "../core/settings";
import { storePath, storeRead, storeWrite } from "../core/store";
import { telemetry } from "../core/telemetry";
import { newToken } from "./http-server";
import { OWNER_ADMIN_ROUTES, OWNER_OPERATIONS, READ_OPERATIONS, READ_ROUTES, ROW_WRITES, SCHEMA_OPERATIONS } from "./token-routes";
import { BadRequest, Forbidden, FORBIDDEN_HINT, isBatchOperation, operationOf, type Body, type Handler, type HandlerResponse } from "./rest";
import { messageOf } from "../core/message";
import { guide } from "../core/hints";

export interface TokenRecord {
  name: string;
  description?: string;
  /** SHA-256 (hex) of the token. */
  tokenHash: string;
  /** Tables the token may write: qualified names, `catalog.schema.*`, `catalog.*` or `*`. */
  write: string[];
  /** May the token change the schema (create_table, add_column, …)? */
  ddl: boolean;
  /**
   * May the token also run the owner's data routes (undo, restore, vacuum, configuration, semantic
   * index)? For an agent's own token. The engine's administration (tokens, webhooks) stays the owner's.
   */
  maintain?: boolean;
  /**
   * The automatic links of the token's writes that pass no `autolink` of their own: true or false;
   * absent, the database's `autolink` setting. Off for sync programs, which write text as they got it.
   */
  autolink?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeen?: string;
}

/** A registry entry as the routes show it: everything but the hash, snake_case (tokens.json keeps its keys). */
export interface PublicToken {
  name: string;
  description?: string;
  write: string[];
  ddl: boolean;
  maintain?: boolean;
  autolink?: boolean;
  created_at: string;
  updated_at: string;
  last_seen?: string;
}

const FILE = "tokens.json";
/** Kebab-case; "owner" is the owner's token in the journal. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_NAMES = new Set(["owner"]);
const SEEN_SAVE_MS = 60_000;

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Does a qualified table name match a permission pattern? */
export function tableAllowed(full: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return full.startsWith(p.slice(0, -1));
    return p === full;
  });
}

/** The named token behind a request: the actor's `auth`, unless it is the owner (or nobody). */
export function tokenNameOf(actor: Actor | undefined): string | undefined {
  const auth = actor?.auth;
  return auth && auth !== "owner" ? auth : undefined;
}

interface Deps {
  app: App;
  getSettings(): DatanotesSettings;
}

export class TokenRegistry {
  private tokens: TokenRecord[] = [];
  private byHash = new Map<string, TokenRecord>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<boolean> = Promise.resolve(true);
  private seenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: Deps) {}

  private path(file: string): string {
    return storePath(file);
  }

  /** Read the registry (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const text = await storeRead(this.deps.app, this.path(FILE));
        if (text !== null) this.tokens = JSON.parse(text) as TokenRecord[];
      } catch (e) {
        telemetry().log("WARN", "datanotes could not read the token registry", { error: messageOf(e) });
        this.tokens = [];
      }
      this.reindex();
    })();
    return this.loaded;
  }

  /** Wait for the last save (the last-seen times are saved within a minute). */
  async stop(): Promise<void> {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = null;
    await this.saving;
  }

  private reindex(): void {
    this.byHash = new Map(this.tokens.map((t) => [t.tokenHash, t]));
  }

  /** Write the registry; false (and a WARN) when it cannot be written: the tokens stay in memory. */
  private save(): Promise<boolean> {
    this.saving = this.saving
      .then(() => storeWrite(this.deps.app, this.path(FILE), `${JSON.stringify(this.tokens, null, 2)}\n`))
      .then(
        () => true,
        (e: unknown) => {
          telemetry().log("WARN", "datanotes could not save tokens.json", { error: messageOf(e) });
          return false;
        },
      );
    return this.saving;
  }

  get(name: string): TokenRecord | undefined {
    return this.tokens.find((t) => t.name === name);
  }

  publicView(t: TokenRecord): PublicToken {
    return {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      write: t.write,
      ddl: t.ddl,
      ...(t.maintain !== undefined ? { maintain: t.maintain } : {}),
      ...(t.autolink !== undefined ? { autolink: t.autolink } : {}),
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      ...(t.lastSeen !== undefined ? { last_seen: t.lastSeen } : {}),
    };
  }

  list(): PublicToken[] {
    return this.tokens.map((t) => this.publicView(t));
  }

  /** The entry of this token, or null. */
  async authenticate(token: string): Promise<TokenRecord | null> {
    if (token.length < 16) return null;
    await this.load();
    const t = this.byHash.get(await sha256Hex(token)) ?? null;
    if (t) this.seen(t);
    return t;
  }

  private seen(t: TokenRecord): void {
    t.lastSeen = new Date().toISOString();
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      void this.save();
    }, SEEN_SAVE_MS);
  }

  async create(input: { name: string; description?: string; write?: string[]; ddl?: boolean; maintain?: boolean; autolink?: boolean }): Promise<{ entry: PublicToken; token: string }> {
    await this.load();
    if (!NAME.test(input.name)) throw new BadRequest(`"name" must be kebab-case (a-z, 0-9, -)`);
    if (RESERVED_NAMES.has(input.name)) throw new BadRequest(`"${input.name}" is reserved (the owner's token)`);
    if (this.get(input.name)) throw new BadRequest(`token ${input.name} already exists (update it, or delete it first)`);
    const token = newToken();
    const now = new Date().toISOString();
    const t: TokenRecord = {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      tokenHash: await sha256Hex(token),
      write: checkPatterns(input.write ?? []),
      ddl: input.ddl === true,
      ...(input.maintain === true ? { maintain: true } : {}),
      ...(input.autolink !== undefined ? { autolink: input.autolink } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.tokens.push(t);
    this.reindex();
    await this.save();
    telemetry().log("INFO", "datanotes token created", { token_name: t.name });
    return { entry: this.publicView(t), token };
  }

  /**
   * Change a token. `self` (a token updating its own entry) may change its description and its
   * `autolink` default; permissions are the owner's. `autolink: null` follows the database again.
   */
  async update(name: string, patch: { description?: string; write?: string[]; ddl?: boolean; maintain?: boolean; autolink?: boolean | null }, self: boolean): Promise<PublicToken> {
    await this.load();
    const t = this.get(name);
    if (!t) throw new BadRequest(`no token ${name}`);
    if (self && (patch.write !== undefined || patch.ddl !== undefined || patch.maintain !== undefined)) throw new Forbidden("a token cannot change its own permissions");
    if (patch.description !== undefined) {
      if (patch.description === "") delete t.description;
      else t.description = patch.description;
    }
    if (patch.write !== undefined) t.write = checkPatterns(patch.write);
    if (patch.ddl !== undefined) t.ddl = patch.ddl;
    if (patch.maintain === true) t.maintain = true;
    else if (patch.maintain === false) delete t.maintain;
    if (patch.autolink === null) delete t.autolink;
    else if (patch.autolink !== undefined) t.autolink = patch.autolink;
    t.updatedAt = new Date().toISOString();
    await this.save();
    return this.publicView(t);
  }

  async remove(name: string): Promise<boolean> {
    await this.load();
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.name !== name);
    if (this.tokens.length === before) return false;
    this.reindex();
    await this.save();
    return true;
  }

  async rotate(name: string): Promise<string> {
    await this.load();
    const t = this.get(name);
    if (!t) throw new BadRequest(`no token ${name}`);
    const token = newToken();
    t.tokenHash = await sha256Hex(token);
    t.updatedAt = new Date().toISOString();
    this.reindex();
    await this.save();
    return token;
  }

  // --- permissions ---------------------------------------------------------------------------

  /** Why this token may not run this route with this body, or null when it may. */
  async check(name: string, route: string, body: unknown): Promise<string | null> {
    const t = this.get(name);
    if (!t) return "unknown token";
    const op = operationOf(route);
    if (op !== undefined) return this.checkOperation(t, op, body);
    if (READ_ROUTES.has(route)) return null;
    return t.maintain && !OWNER_ADMIN_ROUTES.has(route) ? null : `token ${t.name} may not call ${route} (reserved to the owner)`;
  }

  /** Why this token may not run this operation with these arguments, or null when it may. */
  private async checkOperation(t: TokenRecord, op: string, body: unknown): Promise<string | null> {
    if (READ_OPERATIONS.has(op)) return null;
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (op === "batch") {
      const steps = Array.isArray(b.operations) ? b.operations : [];
      for (const [i, raw] of steps.entries()) {
        const step = (raw ?? {}) as Record<string, unknown>;
        // a step that names no write is refused by the batch itself; checked as a schema change meanwhile
        const stepOp = typeof step.op === "string" && isBatchOperation(step.op) ? step.op : "create_table";
        const why = await this.checkOperation(t, stepOp, step);
        if (why) return `operation ${i}: ${why}`;
      }
      return null;
    }
    if (SCHEMA_OPERATIONS.has(op)) return t.ddl ? null : `token ${t.name} may not change the schema`;
    // own keys only: an operation named like an inherited property (`toString`) is not a row write
    const keys = Object.prototype.hasOwnProperty.call(ROW_WRITES, op) ? ROW_WRITES[op] : undefined;
    if (!keys) return t.maintain && !OWNER_OPERATIONS.has(op) ? null : `token ${t.name} may not call ${op} (reserved to the owner)`;
    const model = (await loadMetastore(this.deps.app, this.deps.getSettings()).catch(() => null))?.model ?? null;
    for (const k of keys) {
      const ref = b[k];
      if (ref === undefined || ref === null) continue;
      const full = (model ? rowTableFull(model, ref) : null) ?? String(ref);
      if (!tableAllowed(full, t.write)) return `token ${t.name} may not write ${full}`;
    }
    return null;
  }

  /** Wrap a dispatcher: calls made with a named token are checked first. */
  guard(dispatch: (route: string, handler: Handler, body: unknown) => Promise<HandlerResponse>): (route: string, handler: Handler, body: unknown) => Promise<HandlerResponse> {
    return async (route, handler, body) => {
      const name = tokenNameOf(currentActor());
      if (name) {
        const why = await this.check(name, route, body);
        if (why) {
          telemetry().log("WARN", "datanotes token refused", { token_name: name, "http.route": route, reason: why });
          return { status: 403, json: { error: why, ...FORBIDDEN_HINT } };
        }
        const autolink = this.get(name)?.autolink;
        if (autolink !== undefined) body = withAutolinkDefault(route, body, autolink);
      }
      return dispatch(route, handler, body);
    };
  }

  // --- routes --------------------------------------------------------------------------------

  /** `/datanotes/tokens/*`: the registry for the owner, its own entry for a named token. */
  handlers(): Record<string, Handler> {
    const caller = () => tokenNameOf(currentActor());
    const ownerOnly = () => {
      if (caller()) throw new Forbidden("reserved to the owner");
    };
    const strList = (b: Body, k: string): string[] | undefined => {
      const v = b[k];
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadRequest(`"${k}" must be a list of strings`);
      return v as string[];
    };
    const optStr = (b: Body, k: string): string | undefined => {
      const v = b[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string") throw new BadRequest(`"${k}" must be a string`);
      return v;
    };
    const name = (b: Body): string => {
      const self = caller();
      if (self) return self;
      const n = optStr(b, "name");
      if (!n) throw new BadRequest(`"name" is required`);
      return n;
    };
    return {
      "/tokens/": async () => {
        ownerOnly();
        await this.load();
        return { status: 200, json: { tokens: this.list() } };
      },
      "/tokens/me/": async () => {
        const self = caller();
        if (!self) throw new BadRequest("call this with a named token");
        const t = this.get(self);
        return { status: 200, json: { entry: t ? this.publicView(t) : null } };
      },
      "/tokens/create/": async (b) => {
        ownerOnly();
        const autolink = optAutolink(b, false);
        const description = optStr(b, "description");
        const write = strList(b, "write");
        const r = await this.create({
          name: optStr(b, "name") ?? "",
          ...(description !== undefined ? { description } : {}),
          ...(write ? { write } : {}),
          ...(b.ddl === true ? { ddl: true } : {}),
          ...(b.maintain === true ? { maintain: true } : {}),
          ...(typeof autolink === "boolean" ? { autolink } : {}),
        });
        return { status: 200, json: r };
      },
      "/tokens/update/": async (b) => {
        const self = !!caller();
        for (const k of ["ddl", "maintain"]) if (b[k] !== undefined && typeof b[k] !== "boolean") throw new BadRequest(`"${k}" must be true or false`);
        const description = optStr(b, "description");
        const write = strList(b, "write");
        const autolink = optAutolink(b, true);
        const patch = {
          ...(description !== undefined ? { description } : {}),
          ...(write !== undefined ? { write } : {}),
          ...(typeof b.ddl === "boolean" ? { ddl: b.ddl } : {}),
          ...(typeof b.maintain === "boolean" ? { maintain: b.maintain } : {}),
          ...(autolink !== undefined ? { autolink } : {}),
        };
        return { status: 200, json: { entry: await this.update(name(b), patch, self) } };
      },
      "/tokens/delete/": async (b) => {
        ownerOnly();
        return { status: 200, json: { deleted: await this.remove(name(b)) } };
      },
      "/tokens/rotate/": async (b) => {
        ownerOnly();
        return { status: 200, json: { token: await this.rotate(name(b)) } };
      },
    };
  }
}

/** The writes whose text automatic links link (src/core/autolink.ts). */
const LINKING_OPERATIONS = new Set(["insert_row", "update_row"]);

/**
 * A request as a token with an `autolink` default sends it: the writes that link text, alone or in
 * a batch, get the default when they pass no `autolink` of their own.
 */
export function withAutolinkDefault(route: string, body: unknown, autolink: boolean): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const given = (o: Record<string, unknown>) => o.autolink !== undefined && o.autolink !== null;
  const op = operationOf(route);
  if (op !== undefined && LINKING_OPERATIONS.has(op)) return given(b) ? b : { ...b, autolink };
  if (op !== "batch" || !Array.isArray(b.operations)) return b;
  return {
    ...b,
    operations: b.operations.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const step = raw as Record<string, unknown>;
      return typeof step.op === "string" && LINKING_OPERATIONS.has(step.op) && !given(step) ? { ...step, autolink } : step;
    }),
  };
}

/** A token's `autolink` default as given: true or false, or (on update) null to follow the database. */
function optAutolink(b: Body, nullable: boolean): boolean | null | undefined {
  const v = b.autolink;
  if (v === undefined || (v === null && !nullable)) return undefined;
  if (v === null || typeof v === "boolean") return v;
  throw new BadRequest(
    `"autolink" must be true or false${nullable ? ", or null for the database's setting" : ""}`,
    guide(
      `Pass autolink: false for a sync program's token (its writes keep their text as given), true to link, or ${nullable ? "null" : "leave it out"} to follow the database's autolink setting.`,
      "tokenAutolink",
    ),
  );
}

function checkPatterns(patterns: string[]): string[] {
  for (const p of patterns) {
    if (!/^(\*|[\w-]+(\.[\w-]+){0,2}(\.\*)?)$/.test(p)) throw new BadRequest(`write pattern "${p}" must be a table name, catalog.schema.*, catalog.* or *`);
  }
  return [...new Set(patterns)];
}
