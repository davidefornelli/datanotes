/**
 * Named tokens: each program or agent gets its own token, with its permissions and a name the
 * journal records (docs: guides/security/tokens).
 *
 * The registry lives in the engine's store (`store:tokens.json`). Each entry keeps the token's
 * SHA-256 (never the token), its permissions (`read`: table patterns it may read, every table
 * without it; `write`: table patterns it may write; `ddl`; `maintain`) and when it was last seen.
 * Requests made with a named token carry its name as the actor's `auth` (the owner's token:
 * `"owner"`), so the journal says which token wrote, on behalf of which agent. A token with `read`
 * runs its requests in its read scope (src/core/read-scope.ts): the engine's read sites filter or
 * refuse what it may not read.
 */

import { currentActor, isViewingAs, type Actor } from "../core/actor";
import { matchesTablePattern, READ_SCOPE_SUPPORTED, runWithReadScope, tableReadDenied, type ReadDeniedError, type ReadScope } from "../core/read-scope";
import { runWithWriteScope, type WriteScope } from "../core/write-scope";
import type { App } from "../core/host";
import { catalogTables, catalogViews, loadMetastore, rowTableFull, type Metastore } from "../core/metastore";
import { viewReadable } from "../core/table-registry";
import { tablesReadByView } from "../core/query-tables";
import type { DatanotesSettings } from "../core/settings";
import { storePath, storeRead, storeWrite } from "../core/store";
import { telemetry } from "../core/telemetry";
import { journalTableMoves } from "../core/journal";
import { newToken } from "./http-server";
import { OWNER_ADMIN_ROUTES, OWNER_OPERATIONS, READ_OPERATIONS, READ_ROUTES, READ_SCOPE_UNSUPPORTED, READ_SCOPE_UNSUPPORTED_HINT, READ_TABLE_ARGS, ROW_WRITES, SCHEMA_OPERATIONS, WRITE_SCOPE_UNSUPPORTED, WRITE_SCOPE_UNSUPPORTED_HINT } from "./token-routes";
import { BadRequest, errorResponse, Forbidden, FORBIDDEN_HINT, isBatchOperation, operationOf, type Body, type Handler, type HandlerResponse } from "./rest";
import { messageOf } from "../core/message";
import { guide } from "../core/hints";

export interface TokenRecord {
  name: string;
  description?: string;
  /** SHA-256 (hex) of the token. */
  tokenHash: string;
  /**
   * Tables the token may read: qualified names, `catalog.schema.*`, `catalog.*` or `*`. Absent (or
   * `["*"]`), every table. Every `write` pattern is covered by one of them.
   */
  read?: string[];
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
  /**
   * The journal id of the last table rename or move the lists reflect ("" before any). At start the
   * registry catches up with the renames journaled after it: a stop between the journal and the save.
   */
  movesThrough?: string;
  /** The lists before and after the latest renames that changed them (oldest first): an undo puts them back exactly. */
  follows?: FollowRecord[];
}

/** A token's lists before and after a rename it followed (journal id `migration`). */
export interface FollowRecord {
  migration: string;
  before: TokenLists;
  after: TokenLists;
}

/** A token's `read` (absent: every table) and `write`. */
export interface TokenLists {
  read?: string[];
  write: string[];
}

/** How many renames each token keeps its lists of, for an exact undo. */
const FOLLOWS_KEPT = 10;

/** A table or view of the permission matrix; a view names the tables it reads. */
export interface PermissionObject {
  name: string;
  kind: "table" | "view";
  /** The tables a view reads (sorted). */
  reads?: string[];
  /** False when the tables a view reads are known only when it runs (a vault-wide query). */
  reads_complete?: boolean;
}

/** What one token may do with one table or view, and why. */
export interface PermissionAccess {
  object: string;
  read: boolean;
  write: boolean;
  /** The first `read` pattern that matches the name (when readable). */
  read_pattern?: string;
  /** The first `write` pattern that matches the name. */
  write_pattern?: string;
  /** Why a view is not readable. */
  reason?: string;
}

/** A token's row of the permission matrix. */
export interface TokenPermissions {
  name: string;
  read: string[];
  write: string[];
  ddl: boolean;
  maintain: boolean;
  access: PermissionAccess[];
}

/** A registry entry as the routes show it: everything but the hash, snake_case (tokens.json keeps its keys). */
export interface PublicToken {
  name: string;
  description?: string;
  /** `["*"]` for a token that reads every table. */
  read: string[];
  write: string[];
  ddl: boolean;
  maintain?: boolean;
  autolink?: boolean;
  created_at: string;
  updated_at: string;
  last_seen?: string;
}

/**
 * A token whose exact grant followed a table renamed or moved (alter_table, or the undo of one):
 * `from` became `to` in the lists of `permissions` (guides/security/tokens#a-renamed-table-keeps-its-grants).
 */
export interface TokenFollow {
  token: string;
  from: string;
  to: string;
  /** The lists that changed: "read", "write" or both. */
  permissions: ("read" | "write")[];
}

/** How many renames' followed tokens are kept for their answers (those never asked for go first). */
const FOLLOWED_KEPT = 100;

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
  return matchesTablePattern(full, patterns);
}

/** What a token may read while its requests run: null (everything) without `read` or with `*` in it. */
export function scopeOf(t: TokenRecord): ReadScope | null {
  return t.read === undefined || t.read.includes("*") ? null : { token: t.name, patterns: t.read };
}

/**
 * What a token's row writes may change while its requests run: null (every table) with `*` in
 * `write`. The engine refuses a write that changes rows of another table (src/core/write-scope.ts).
 */
export function writeScopeOf(t: TokenRecord): WriteScope | null {
  return t.write.includes("*") ? null : { token: t.name, patterns: t.write };
}

/** Does this route write rows (a row write, or a batch)? */
function writesRows(route: string): boolean {
  const op = operationOf(route);
  return op === "batch" || (op !== undefined && Object.prototype.hasOwnProperty.call(ROW_WRITES, op));
}

/**
 * Does read pattern `r` cover write pattern `w` (every table `w` matches, `r` matches)? `*` covers
 * everything; `personal.*` covers `personal.food.*` and `personal.food.pantry`; only `*` covers `*`.
 */
export function readCovers(r: string, w: string): boolean {
  return r === "*" || r === w || (r.endsWith(".*") && w.startsWith(r.slice(0, -1)));
}

/** The named token behind a request: the actor's `auth`, unless it is the owner (or nobody). */
export function tokenNameOf(actor: Actor | undefined): string | undefined {
  const auth = actor?.auth;
  return auth && auth !== "owner" ? auth : undefined;
}

interface Deps {
  app: App;
  getSettings(): DatanotesSettings;
  /** Whether a read or write scope can be carried through a request (default: READ_SCOPE_SUPPORTED); a test seam. */
  readScopeSupported?: boolean;
}

export class TokenRegistry {
  private tokens: TokenRecord[] = [];
  private byHash = new Map<string, TokenRecord>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<boolean> = Promise.resolve(true);
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  /** The renames being followed (see followTableMoves): stop() waits for them. */
  private following: Promise<unknown> = Promise.resolve();
  /** The tokens that followed each rename, by journal id, until its answer takes them. */
  private followed = new Map<string, Promise<TokenFollow[]>>();
  /** The journal id of the last rename the registry followed ("" before any; unknown before load). */
  private movesThrough: string | undefined;
  /** The renames followed at start (catchUp), by journal id: their apply hook changes nothing more. */
  private caughtUp = new Map<string, TokenFollow[]>();

  constructor(private readonly deps: Deps) {}

  private path(file: string): string {
    return storePath(file);
  }

  /** Read the registry (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const text = await storeRead(this.deps.app, this.path(FILE));
        if (text !== null) {
          const records = JSON.parse(text) as unknown[];
          // an entry edited by hand into a number, a string, null or a list is no token: skipped
          this.tokens = records.filter((t): t is TokenRecord => t !== null && typeof t === "object" && !Array.isArray(t));
          const skipped = records.length - this.tokens.length;
          if (skipped > 0) telemetry().log("WARN", "datanotes skipped token registry entries that are not objects", { skipped });
        }
      } catch (e) {
        telemetry().log("WARN", "datanotes could not read the token registry", { error: messageOf(e) });
        this.tokens = [];
      }
      this.reindex();
      await this.catchUp();
    })();
    return this.loaded;
  }

  /**
   * Follow the renames journaled after the registry's last save (a stop or crash between the
   * journal and the save), in journal order, as the apply hook would have: each token from the
   * rename after its own `movesThrough`. A token without one (written by an older engine, or by
   * hand) starts from now. Then every token is marked as through the last rename, and saved.
   */
  private async catchUp(): Promise<void> {
    try {
      const marks = this.tokens.map((t) => t.movesThrough);
      // the journal from the oldest month a token still needs; all of it to learn the last rename
      const from = marks.length > 0 && marks.every((m) => typeof m === "string" && m !== "") ? (marks as string[]).sort()[0] : undefined;
      const entries = await journalTableMoves(this.deps.app, this.deps.getSettings(), from);
      // as the apply hook: a write that failed partway, and its rollback, renamed nothing
      const skipped = new Set<string>();
      const kept = entries.filter((e) => {
        if (!e.failed && !(e.undoes !== undefined && skipped.has(e.undoes))) return true;
        skipped.add(e.migration_id);
        return false;
      });
      const ids = kept.map((e) => e.migration_id);
      // where each token is: -1 before every rename kept (or its mark is gone with the journal's old entries)
      const at = new Map(this.tokens.map((t) => [t, typeof t.movesThrough === "string" ? ids.indexOf(t.movesThrough) : ids.length - 1]));
      let changed = false;
      kept.forEach((e, i) => {
        const behind = this.tokens.filter((t) => at.get(t)! < i);
        if (behind.length === 0) return;
        const follows = this.applyMoves(e.migration_id, e.table_moves, e.undoes, behind, true);
        if (follows.length > 0) changed = true;
        this.caughtUp.set(e.migration_id, follows);
      });
      const last = ids.at(-1) ?? "";
      this.movesThrough = last;
      for (const t of this.tokens) {
        if (t.movesThrough === last) continue;
        t.movesThrough = last;
        changed = true;
      }
      if (changed) await this.save();
    } catch (e) {
      telemetry().log("WARN", "datanotes could not catch up with the renamed tables", { error: messageOf(e) });
    }
  }

  /**
   * Put each move's new name in the tokens' lists (followMove) and mark every token as through
   * this rename. Returns the tokens that followed, each logged.
   */
  private applyMoves(migrationId: string, moves: readonly { from: string; to: string }[], undoes: string | undefined, tokens: readonly TokenRecord[], recovered = false): TokenFollow[] {
    const follows: TokenFollow[] = [];
    for (const t of tokens) {
      let followed: TokenFollow[];
      try {
        followed = followRename(t, migrationId, moves, undoes);
      } catch (e) {
        // a record edited by hand into a wrong shape (no `write`): the others follow, the engine serves on
        telemetry().log("WARN", "datanotes token could not follow a renamed table", { token_name: String(t.name), migration_id: migrationId, error: messageOf(e) });
        continue;
      }
      for (const f of followed) {
        follows.push(f);
        telemetry().log("INFO", "datanotes token followed a renamed table", { token_name: t.name, from: f.from, to: f.to, permissions: f.permissions.join(","), migration_id: migrationId, ...(recovered ? { at_start: true } : {}) });
      }
    }
    if (!recovered) {
      this.movesThrough = migrationId;
      for (const t of this.tokens) t.movesThrough = migrationId;
    }
    return follows;
  }

  /** Wait for the last save (the last-seen times are saved within a minute). */
  async stop(): Promise<void> {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = null;
    await this.following;
    await this.saving;
  }

  /**
   * A table was renamed or moved (an operation the engine applied and journaled: alter_table, or
   * an undo putting the old name back). Each token whose `read` or `write` holds exactly the old
   * name gets the new one in its place; patterns (`catalog.schema.*`, `catalog.*`, `*`) are left
   * as they are. Called by the engine's apply hook, in order: the change is made in memory at
   * once (the next request sees it) and saved with the registry's other saves, one at a time.
   */
  followTableMoves(migrationId: string, moves: readonly { from: string; to: string }[], undoes?: string): void {
    const done = this.load().then(async () => {
      // journaled before the registry was read: followed at start already
      const caught = this.caughtUp.get(migrationId);
      if (caught) return caught;
      const follows = this.applyMoves(migrationId, moves, undoes, this.tokens);
      // a rename no token followed is not saved: the catch-up at start finds nothing to change either
      if (follows.length > 0) await this.save();
      return follows;
    }).catch((e: unknown): TokenFollow[] => {
      // never a rejection: the chain goes on, the rename's answer lists no token, the engine serves on
      telemetry().log("WARN", "datanotes tokens could not follow a renamed table", { migration_id: migrationId, error: messageOf(e) });
      return [];
    });
    this.following = this.following.then(() => done);
    this.followed.set(migrationId, done);
    for (const id of this.followed.keys()) {
      if (this.followed.size <= FOLLOWED_KEPT) break;
      this.followed.delete(id);
    }
  }

  /**
   * The tokens that followed the renames of these journal entries (once saved), each told once:
   * what the answer of the rename (or its undo) lists for the owner.
   */
  async takeFollowed(migrationIds: readonly string[]): Promise<TokenFollow[]> {
    const out: TokenFollow[] = [];
    for (const id of migrationIds) {
      const p = this.followed.get(id);
      if (!p) continue;
      this.followed.delete(id);
      out.push(...(await p));
    }
    return out;
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
      read: t.read ?? ["*"],
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

  /**
   * The permission matrix: every table and view, and what each named token (or the one named) may
   * read and write in it, as the engine applies it (a view: by its name and the tables it reads).
   */
  async permissions(name?: string): Promise<{ objects: PermissionObject[]; tokens: TokenPermissions[] }> {
    await this.load();
    const chosen = name === undefined ? this.tokens : this.tokens.filter((t) => t.name === name);
    if (name !== undefined && chosen.length === 0) throw new BadRequest(`no token ${name}`, guide(`tokens/ lists the named tokens; leave "name" out for all of them.`, "tokenPermissions"));
    const model = (await loadMetastore(this.deps.app, this.deps.getSettings()).catch(() => null))?.model ?? null;
    const objects: PermissionObject[] = [];
    if (model) {
      for (const full of catalogTables(model).map(({ ref }) => ref.full).sort()) objects.push({ name: full, kind: "table" });
      for (const full of catalogViews(model).map(({ ref }) => ref.full).sort()) {
        const reads = tablesReadByView(model, full);
        objects.push({ name: full, kind: "view", reads: [...new Set(reads.tables)].sort(), reads_complete: reads.complete });
      }
    }
    return { objects, tokens: chosen.map((t) => this.tokenPermissions(t, model, objects)) };
  }

  private tokenPermissions(t: TokenRecord, model: Metastore | null, objects: PermissionObject[]): TokenPermissions {
    const pub = this.publicView(t);
    const scope = scopeOf(t);
    const access: PermissionAccess[] = [];
    for (const o of objects) {
      const readPattern = pub.read.find((p) => matchesTablePattern(o.name, [p]));
      if (o.kind === "table") {
        const writePattern = t.write.find((p) => matchesTablePattern(o.name, [p]));
        access.push({
          object: o.name,
          read: scope === null || readPattern !== undefined,
          write: writePattern !== undefined,
          ...(readPattern !== undefined ? { read_pattern: readPattern } : {}),
          ...(writePattern !== undefined ? { write_pattern: writePattern } : {}),
        });
        continue;
      }
      const read = viewReadable(model!, o.name, scope);
      access.push({
        object: o.name,
        read,
        write: false,
        ...(read && readPattern !== undefined ? { read_pattern: readPattern } : {}),
        ...(read ? {} : { reason: viewUnreadableReason(t.name, o, readPattern !== undefined, scope) }),
      });
    }
    return { name: t.name, read: pub.read, write: t.write, ddl: t.ddl, maintain: t.maintain === true, access };
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

  async create(input: { name: string; description?: string; read?: string[]; write?: string[]; ddl?: boolean; maintain?: boolean; autolink?: boolean }): Promise<{ entry: PublicToken; token: string }> {
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
      ...(input.read !== undefined ? { read: readPatterns(input.read) } : {}),
      write: checkPatterns(input.write ?? [], "write"),
      ddl: input.ddl === true,
      ...(input.maintain === true ? { maintain: true } : {}),
      ...(input.autolink !== undefined ? { autolink: input.autolink } : {}),
      createdAt: now,
      updatedAt: now,
      // its lists are as they are now: the renames journaled so far are not followed again at start
      ...(this.movesThrough !== undefined ? { movesThrough: this.movesThrough } : {}),
    };
    checkReadCoversPermissions(t);
    this.tokens.push(t);
    this.reindex();
    await this.save();
    telemetry().log("INFO", "datanotes token created", { token_name: t.name });
    return { entry: this.publicView(t), token };
  }

  /**
   * Change a token. `self` (a token updating its own entry) may change its description and its
   * `autolink` default; permissions are the owner's. `autolink: null` follows the database again,
   * `read: null` reads every table again. Nothing changes when the token as changed would be refused.
   */
  async update(name: string, patch: { description?: string; read?: string[] | null; write?: string[]; ddl?: boolean; maintain?: boolean; autolink?: boolean | null }, self: boolean): Promise<PublicToken> {
    await this.load();
    const t = this.get(name);
    if (!t) throw new BadRequest(`no token ${name}`);
    if (self && (patch.read !== undefined || patch.write !== undefined || patch.ddl !== undefined || patch.maintain !== undefined)) throw new Forbidden("a token cannot change its own permissions");
    const next: TokenRecord = { ...t };
    if (patch.description !== undefined) {
      if (patch.description === "") delete next.description;
      else next.description = patch.description;
    }
    if (patch.read === null) delete next.read;
    else if (patch.read !== undefined) next.read = readPatterns(patch.read);
    if (patch.write !== undefined) next.write = checkPatterns(patch.write, "write");
    if (patch.ddl !== undefined) next.ddl = patch.ddl;
    if (patch.maintain === true) next.maintain = true;
    else if (patch.maintain === false) delete next.maintain;
    if (patch.autolink === null) delete next.autolink;
    else if (patch.autolink !== undefined) next.autolink = patch.autolink;
    checkReadCoversPermissions(next);
    next.updatedAt = new Date().toISOString();
    // the same entry, changed in place: the requests that hold it see the change
    for (const k of Object.keys(t) as (keyof TokenRecord)[]) if (!(k in next)) delete t[k];
    Object.assign(t, next);
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

  /**
   * Why this token may not run this route with this body, or null when it may: the reason of a
   * refused write or route, or the refusal of a read (the same error the engine's read sites throw).
   */
  async check(name: string, route: string, body: unknown): Promise<string | ReadDeniedError | null> {
    const t = this.get(name);
    if (!t) return "unknown token";
    const op = operationOf(route);
    if (op !== undefined) return this.checkOperation(t, op, body);
    if (READ_ROUTES.has(route)) return null;
    return t.maintain && !OWNER_ADMIN_ROUTES.has(route) ? null : `token ${t.name} may not call ${route} (reserved to the owner)`;
  }

  /** Why this token may not run this operation with these arguments, or null when it may. */
  private async checkOperation(t: TokenRecord, op: string, body: unknown): Promise<string | ReadDeniedError | null> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (READ_OPERATIONS.has(op)) return this.checkRead(t, op, b);
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

  /**
   * The refusal of a read whose arguments name a table the token may not read, or null. Only names
   * that resolve to a table are checked here (a view, `base:x`, the system catalog or an unknown
   * name pass): the engine's read sites decide the rest while the request runs in the token's scope.
   */
  private async checkRead(t: TokenRecord, op: string, b: Record<string, unknown>): Promise<ReadDeniedError | null> {
    const scope = scopeOf(t);
    if (!scope) return null;
    const names: unknown[] = (Object.prototype.hasOwnProperty.call(READ_TABLE_ARGS, op) ? READ_TABLE_ARGS[op]! : []).map((k) => b[k]);
    // semantic_search and search: each exact name of `tables` (a pattern with `*` is narrowed by the engine)
    if ((op === "semantic_search" || op === "search") && Array.isArray(b.tables)) names.push(...b.tables.filter((x) => typeof x === "string" && !x.includes("*")));
    if (!names.some((n) => typeof n === "string")) return null;
    const model = (await loadMetastore(this.deps.app, this.deps.getSettings()).catch(() => null))?.model ?? null;
    if (!model) return null;
    for (const ref of names) {
      const full = rowTableFull(model, ref);
      if (full !== null && !matchesTablePattern(full, scope.patterns)) return tableReadDenied(t.name, full);
    }
    return null;
  }

  /** Wrap a dispatcher: calls made with a named token are checked first, and run in its read scope. */
  guard(dispatch: (route: string, handler: Handler, body: unknown) => Promise<HandlerResponse>): (route: string, handler: Handler, body: unknown) => Promise<HandlerResponse> {
    return async (route, handler, body) => {
      const name = tokenNameOf(currentActor());
      if (!name) return dispatch(route, handler, body);
      const viewAs = isViewingAs(currentActor()) ? { view_as: true } : {};
      const why = await this.check(name, route, body);
      if (why) {
        const reason = typeof why === "string" ? why : why.message;
        telemetry().log("WARN", "datanotes token refused", { token_name: name, "http.route": route, reason, ...viewAs });
        return typeof why === "string" ? { status: 403, json: { error: why, ...FORBIDDEN_HINT } } : errorResponse(why);
      }
      const token = this.get(name)!; // check() refuses an unknown token
      if (token.autolink !== undefined) body = withAutolinkDefault(route, body, token.autolink);
      const scope = scopeOf(token);
      // fail closed: a restricted token never gets an answer that its read scope did not filter
      if (scope && !(this.deps.readScopeSupported ?? READ_SCOPE_SUPPORTED)) {
        telemetry().log("WARN", "datanotes token refused", { token_name: name, "http.route": route, reason: READ_SCOPE_UNSUPPORTED, ...viewAs });
        return { status: 503, json: { error: READ_SCOPE_UNSUPPORTED, ...READ_SCOPE_UNSUPPORTED_HINT } };
      }
      const writeScope = writeScopeOf(token);
      // fail closed too: a row write whose changes to other tables cannot be checked is not run
      if (writeScope && writesRows(route) && !(this.deps.readScopeSupported ?? READ_SCOPE_SUPPORTED)) {
        telemetry().log("WARN", "datanotes token refused", { token_name: name, "http.route": route, reason: WRITE_SCOPE_UNSUPPORTED, ...viewAs });
        return { status: 503, json: { error: WRITE_SCOPE_UNSUPPORTED, ...WRITE_SCOPE_UNSUPPORTED_HINT } };
      }
      return runWithReadScope(scope, () => runWithWriteScope(writeScope, () => dispatch(route, handler, body)));
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
    /** A list of strings, or null (on update: back to the default), or undefined when absent. */
    const strListOrNull = (b: Body, k: string): string[] | null | undefined => (b[k] === null ? null : strList(b, k));
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
      "/tokens/permissions/": async (b) => {
        ownerOnly();
        const n = optStr(b, "name");
        return { status: 200, json: await this.permissions(n) };
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
        const read = strList(b, "read");
        const write = strList(b, "write");
        const r = await this.create({
          name: optStr(b, "name") ?? "",
          ...(description !== undefined ? { description } : {}),
          ...(read ? { read } : {}),
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
        const read = strListOrNull(b, "read");
        const write = strList(b, "write");
        const autolink = optAutolink(b, true);
        const patch = {
          ...(description !== undefined ? { description } : {}),
          ...(read !== undefined ? { read } : {}),
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

/**
 * A token follows the moves of one operation (journal id `migration`). The undo of a rename it
 * followed (`undoes`) puts its lists back exactly as they were, unless they changed since: then,
 * as for any rename, each move's new name takes the old one's place (followMove). The lists before
 * and after are kept for an undo (the latest {@link FOLLOWS_KEPT}). Returns what changed, by move.
 */
export function followRename(t: TokenRecord, migration: string, moves: readonly { from: string; to: string }[], undoes?: string): TokenFollow[] {
  const before = listsOf(t);
  let kept = undoes !== undefined && Array.isArray(t.follows) ? t.follows.find((f) => isObject(f) && f.migration === undoes) : undefined;
  if (kept && !restorable(t, kept)) {
    // edited by hand into lists a token may not hold: the undo follows by name, as for an edited token
    telemetry().log("WARN", "datanotes token's kept lists are not valid: its undo follows by name", { token_name: t.name, migration_id: migration });
    kept = undefined;
  }
  let follows: TokenFollow[];
  if (kept && sameLists(before, kept.after)) {
    const permissions = (["read", "write"] as const).filter((k) => !sameList(before[k], kept.before[k]));
    if (kept.before.read === undefined) delete t.read;
    else t.read = [...kept.before.read];
    t.write = [...kept.before.write];
    follows = moves.map((m) => ({ token: t.name, from: m.from, to: m.to, permissions: [...permissions] }));
  } else {
    follows = moves.flatMap((m) => {
      const permissions = followMove(t, m.from, m.to);
      return permissions.length > 0 ? [{ token: t.name, from: m.from, to: m.to, permissions }] : [];
    });
  }
  if (follows.length === 0) return [];
  t.follows = [...(Array.isArray(t.follows) ? t.follows : []), { migration, before, after: listsOf(t) }].slice(-FOLLOWS_KEPT);
  return follows;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isStrings(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

function isLists(x: unknown): x is TokenLists {
  return isObject(x) && isStrings(x.write) && (x.read === undefined || isStrings(x.read));
}

/**
 * Can an undo put back the lists a token kept (`follows`)? Both lists of each side are lists of
 * strings, and the lists before pass the rules of a token's create and update.
 */
function restorable(t: TokenRecord, f: FollowRecord): boolean {
  if (!isLists(f.before) || !isLists(f.after)) return false;
  try {
    checkPatterns(f.before.write, "write");
    if (f.before.read !== undefined) checkPatterns(f.before.read, "read");
    const { read: _read, ...rest } = t;
    checkReadCoversPermissions({ ...rest, ...(f.before.read !== undefined ? { read: f.before.read } : {}), write: f.before.write });
    return true;
  } catch {
    return false;
  }
}

function listsOf(t: TokenRecord): TokenLists {
  return { ...(t.read !== undefined ? { read: [...t.read] } : {}), write: [...t.write] };
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameLists(a: TokenLists, b: TokenLists): boolean {
  return sameList(a.read, b.read) && sameList(a.write, b.write);
}

/**
 * Put `to` where a token's `read` and `write` hold exactly `from` (same place; dropped when `to`
 * is there already). A write that follows needs read too: a restricted `read` that no longer
 * covers `to` (it matched `from` by a pattern) gets `to` as well. Returns the lists that changed;
 * the token's times (`updatedAt`, `lastSeen`) stay as they are.
 */
export function followMove(t: TokenRecord, from: string, to: string): ("read" | "write")[] {
  const changed: ("read" | "write")[] = [];
  const renamed = (list: readonly string[]): string[] | null => {
    const i = list.indexOf(from);
    if (i < 0) return null;
    return list.includes(to) ? list.filter((p) => p !== from) : list.map((p) => (p === from ? to : p));
  };
  const write = renamed(t.write);
  if (write) {
    t.write = write;
    changed.push("write");
  }
  if (t.read !== undefined) {
    let read = renamed(t.read);
    if (write && !(read ?? t.read).some((r) => readCovers(r, to))) read = [...(read ?? t.read), to];
    if (read) {
      t.read = read;
      changed.unshift("read");
    }
  }
  return changed;
}

/** Why a token may not read a view: its name, its unknown tables, or the tables it may not read. */
function viewUnreadableReason(token: string, o: PermissionObject, nameMatches: boolean, scope: ReadScope | null): string {
  if (!nameMatches) return `its name matches no read pattern of ${token}`;
  if (o.reads_complete === false) return `the tables it reads are known only when it runs: listings hide it from ${token}`;
  const denied = o.reads!.filter((t) => !matchesTablePattern(t, scope!.patterns));
  return `it reads ${denied.join(", ")}, which ${token} may not read`;
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

function checkPatterns(patterns: string[], field: "read" | "write"): string[] {
  for (const p of patterns) {
    if (!/^(\*|[\w-]+(\.[\w-]+){0,2}(\.\*)?)$/.test(p)) {
      throw new BadRequest(`${field} pattern "${p}" must be a table name, catalog.schema.*, catalog.* or *`, field === "read" ? guide(`Write each read pattern as catalog.schema.table, catalog.schema.*, catalog.* or *; list_tables gives the full names.`, "tokenRead") : undefined);
    }
  }
  return [...new Set(patterns)];
}

/** Read patterns as stored: checked, each once; a list holding `*` is just `["*"]`. */
function readPatterns(patterns: string[]): string[] {
  const read = checkPatterns(patterns, "read");
  return read.includes("*") ? ["*"] : read;
}

/**
 * Refuse a token whose `read` does not cover its other permissions: `ddl` and `maintain` read every
 * table, and each `write` pattern must be readable (a write answers with the rows it touches).
 */
function checkReadCoversPermissions(t: TokenRecord): void {
  const read = t.read;
  if (read === undefined || read.includes("*")) return;
  if (t.ddl || t.maintain === true) {
    throw new BadRequest(`token ${t.name}: "ddl" and "maintain" need read on every table`, guide(`Leave "read" out (or pass ["*"]) for a token with ddl or maintain, or turn them off.`, "tokenRead"));
  }
  for (const w of t.write) {
    if (!read.some((r) => readCovers(r, w))) throw new BadRequest(`token ${t.name} writes ${w} but may not read it`, guide(`Add "${w}" (or a wider pattern) to "read": a write answers with the rows it touches.`, "tokenRead"));
  }
}
