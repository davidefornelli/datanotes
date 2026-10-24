/**
 * `datanotes status`: the health of the engine running on a vault, at a glance.
 *
 *   datanotes status --vault <folder> [--store <folder>] [--settings <file>]
 *                    [--url <url>] [--token <token>] [--json]
 *
 * (or DATANOTES_DATABASE / DATANOTES_VAULT, DATANOTES_SETTINGS, DATANOTES_URL, DATANOTES_TOKEN).
 *
 * The running engine is found through the lock in its store (`engine.lock`: pid, host,
 * port) and called with the owner's token from the settings file; `POST /datanotes/status/`
 * answers the report (`src/server/status.ts`). When no engine answers, what can be read from the
 * files is shown instead: the lock, the settings file, the metastore.
 *
 * Exit codes: 0 healthy, 1 something needs attention (git sync blocked, the store backup failing, a webhook failing, the
 * change feed not running, hand edits breaking the tables' rules), 2 no engine running (or
 * reachable) on the vault, 3 an engine runs but its status could not be read (no owner token, a
 * refused or failed request).
 */

import fs from "node:fs";
import { folderArg, readOptions, type OptionSpec } from "../api/cli-options";
import os from "node:os";
import path from "node:path";
import { catalogTables, parseMetastore } from "../core/metastore";
import { messageOf } from "../core/message";
import { SETTINGS_FILE, storeLocation, vaultDatabaseFolder } from "../api/local";
import { LOCK_PATH_SUFFIX, LOCK_STALE_MS, type EngineLock } from "../server/engine-lock";
import type { EngineStatus } from "../server/status";

export interface StatusOptions {
  vault?: string;
  settingsFile?: string;
  /** `--store`: the store folder itself (else DATANOTES_STORE, else found by the database's id). */
  store?: string;
  url?: string;
  token?: string;
  json: boolean;
  /** The environment the store is found with (DATANOTES_DATA_HOME, DATANOTES_STORE...). */
  env?: Record<string, string | undefined>;
}

export const EXIT_HEALTHY = 0;
export const EXIT_ATTENTION = 1;
export const EXIT_NOT_RUNNING = 2;
/** An engine runs, but its status could not be read (no owner token, a refused or failed request). */
export const EXIT_UNCHECKED = 3;

/** The options of `datanotes status`. */
export const STATUS_OPTIONS: OptionSpec = { values: ["vault", "database", "settings", "store", "url", "token"], flags: ["json"] };

export function parseStatusArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): StatusOptions {
  const o = readOptions(argv, STATUS_OPTIONS, "datanotes status");
  const get = (name: string) => o.get(name);
  const vault = folderArg(o, env, "datanotes status", false)?.folder;
  const settingsFile = get("settings") ?? env.DATANOTES_SETTINGS;
  const store = get("store");
  const url = get("url") ?? env.DATANOTES_URL;
  const token = get("token") ?? env.DATANOTES_TOKEN;
  if (!vault && !(url && token)) throw new Error("pass --database <folder> (or --vault <folder>, DATANOTES_DATABASE, DATANOTES_VAULT), or --url and --token");
  return {
    ...(vault ? { vault: path.resolve(vault) } : {}),
    ...(settingsFile ? { settingsFile: path.resolve(settingsFile) } : {}),
    ...(store ? { store: path.resolve(store) } : {}),
    ...(url ? { url: url.replace(/\/+$/, "") } : {}),
    ...(token ? { token } : {}),
    json: o.has("json"),
  };
}

/** What the files say when no engine answers. */
export interface OfflineReport {
  running: false;
  reason: string;
  vault: string | null;
  lock: { state: "none" | "stale" | "fresh" | "other_host"; pid?: number; host_name?: string; port?: number; heartbeat?: string };
  settings: { file: string; found: boolean; owner_token_set: boolean } | null;
  metastore: { path: string; found: boolean; tables?: number; error?: string } | null;
  /** The store found for the vault, and the database id (null: none yet, or no vault given). */
  store: { path: string; database_id: string | null } | null;
}

export type StatusReport = ({ running: true; url: string } & EngineStatus) | OfflineReport;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The database's files as they are now: its store (settings, lock), its metastore. The store is
 * found as the engine finds it (src/api/local.ts).
 */
function readVault(o: StatusOptions, now: number) {
  if (!o.vault) return null;
  const loc = storeLocation(o.vault, { ...(o.env ? { env: o.env } : {}), ...(o.store ? { store: o.store } : {}) });
  const dir = loc?.store ?? null;
  const file = o.settingsFile ?? (dir ? path.join(dir, SETTINGS_FILE) : null);
  const raw = file ? readJson(file) : null;
  const token = typeof raw?.httpServerToken === "string" ? raw.httpServerToken : "";
  const lock = dir ? (readJson(path.join(dir, LOCK_PATH_SUFFIX)) as EngineLock | null) : null;
  const fresh = !!lock && now - Date.parse(lock.heartbeat) < LOCK_STALE_MS;
  const meta = path.join(o.vault, ...(loc?.database ?? vaultDatabaseFolder(o.vault)).split("/"), "metastore.yaml");
  return { file, found: raw !== null, token, lock, fresh, meta, store: loc ? { path: loc.store, database_id: loc.id } : null };
}

function offlineMetastore(file: string): OfflineReport["metastore"] {
  if (!fs.existsSync(file)) return { path: file, found: false };
  try {
    return { path: file, found: true, tables: catalogTables(parseMetastore(fs.readFileSync(file, "utf8"))).length };
  } catch (e) {
    return { path: file, found: true, error: messageOf(e) };
  }
}

export interface StatusDeps {
  fetch?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}

/** The report and the exit code (nothing printed). */
export async function collectStatus(o: StatusOptions, deps: StatusDeps = {}): Promise<{ code: number; report: StatusReport | { running: true; url: string; error: string } }> {
  const now = deps.now ?? Date.now();
  const v = readVault(o, now);
  const offline = (reason: string): { code: number; report: OfflineReport } => ({
    code: EXIT_NOT_RUNNING,
    report: {
      running: false,
      reason,
      vault: o.vault ?? null,
      lock: !v?.lock
        ? { state: "none" }
        : { state: !v.fresh ? "stale" : v.lock.host !== os.hostname() ? "other_host" : "fresh", pid: v.lock.pid, host_name: v.lock.host, port: v.lock.port, heartbeat: v.lock.heartbeat },
      settings: v?.file ? { file: v.file, found: v.found, owner_token_set: v.token !== "" } : null,
      store: v?.store ?? null,
      metastore: v ? offlineMetastore(v.meta) : null,
    },
  });
  let url = o.url;
  if (!url) {
    // parseStatusArgs asks for --vault unless --url is given
    if (!v!.lock) return offline("no engine holds the vault (no lock)");
    if (!v!.fresh) return offline(`the lock is stale: engine pid ${v!.lock.pid} on ${v!.lock.host} stopped without removing it`);
    if (v!.lock.host !== os.hostname()) return offline(`the vault is held by an engine on ${v!.lock.host} (pid ${v!.lock.pid}): pass its --url and --token`);
    // port 0 in the lock: an engine on any free port, before its HTTP server listens
    if (v!.lock.port === 0) return offline(`the engine (pid ${v!.lock.pid}) is starting: its HTTP server does not listen yet`);
    url = `http://127.0.0.1:${v!.lock.port}`;
  }
  const token = o.token ?? v?.token ?? "";
  if (!token) return { code: EXIT_UNCHECKED, report: { running: true, url, error: `no owner token: httpServerToken is not in ${v?.file ?? "the settings"} (or pass --token)` } };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${url}/datanotes/status/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return offline(`nothing answers at ${url} (${cause ?? messageOf(e)})`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200) {
    const why =
      res.status === 401 ? "the token was refused (401): status needs the owner's token" : res.status === 403 ? "a named token cannot read the status (403): it needs the owner's token" : `HTTP ${res.status}`;
    return { code: EXIT_UNCHECKED, report: { running: true, url, error: `${why}${typeof body.error === "string" ? `: ${body.error}` : ""}` } };
  }
  const status = body as unknown as EngineStatus;
  return { code: status.healthy ? EXIT_HEALTHY : EXIT_ATTENTION, report: { running: true, url, ...status } };
}

/** `3725` → `1h 2m`. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : `${seconds}s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The report for a person: one line per part, the problems at the end. */
export function formatStatus(r: StatusReport | { running: true; url: string; error: string }): string {
  const out: string[] = [];
  const line = (label: string, text: string) => out.push(`${label.padEnd(11)}${text}`);
  if (!r.running) {
    out.push("datanotes status: not running");
    if (r.vault) line("vault", r.vault);
    const l = r.lock;
    line("lock", l.state === "none" ? "none" : `${l.state === "fresh" ? "held" : l.state.replace("_", " ")} (pid ${l.pid} on ${l.host_name}, port ${l.port}, heartbeat ${l.heartbeat})`);
    if (r.store) line("store", `${r.store.path} (database id ${r.store.database_id ?? "unknown"})`);
    if (r.settings) line("settings", `${r.settings.file}${r.settings.found ? (r.settings.owner_token_set ? " (owner token set)" : " (no owner token yet)") : " (not found)"}`);
    if (r.metastore) {
      const m = r.metastore;
      line("metastore", `${m.path}: ${!m.found ? "not found" : m.error ? `cannot be read: ${m.error}` : plural(m.tables!, "table")}`);
    }
    line("reason", r.reason);
    return out.join("\n");
  }
  if ("error" in r) return `datanotes status: engine at ${r.url} did not answer the status\n${"error".padEnd(11)}${r.error}`;
  out.push(`datanotes status: ${r.healthy ? "healthy" : "needs attention"}`);
  const e = r.engine;
  line("engine", `${e.version}, pid ${e.pid ?? "?"} on ${e.host_name ?? "?"}, up ${formatUptime(e.uptime_s)}, ${r.url}${e.watch ? `, watch ${e.watch}` : ""}`);
  if (e.vault) line("vault", `${e.vault}${e.settings_file ? ` (settings ${e.settings_file})` : ""}`);
  line("store", `${e.store ?? "none (in the vault)"}, database ${e.database_folder}${e.database_id ? ` (id ${e.database_id})` : ""}`);
  const d = r.database;
  line("database", `${d.metastore}: ${d.readable ? `${plural(d.tables, "table")} (${d.history_tables} with history), ${plural(d.views, "view")}` : d.error}`);
  if (d.moved) line("moved", `database folder ${d.moved.from} -> ${d.moved.to} at ${d.moved.at}${d.moved.by === "hand" ? " (by hand)" : " (configure_database)"}`);
  const j = d.journal;
  line("journal", `${plural(j.operations, "operation")} in the last ${j.window_hours} h${j.last ? `; last ${j.last.op} at ${j.last.executed_at}${j.last.by ? ` by ${j.last.by}` : ""}` : ""}`);
  const g = r.git_sync;
  line(
    "git sync",
    !g
      ? "off"
      : g.blocked
        ? `BLOCKED: ${g.blocked}`
        : `${g.enabled ? "on" : "stopped"}${g.repo ? `, repo ${g.repo}` : ""}, last commit ${g.last_commit ?? "none"}, last push ${g.last_push_at ?? "none"}, ${plural(g.pending_operations, "pending operation")}`,
  );
  const sb = r.store_backup;
  line(
    "backup",
    !sb
      ? "off"
      : `${sb.last_error ? "FAILING" : sb.enabled ? "on" : "stopped"}, every ${sb.interval_s} s, remote ${sb.remote ?? "none (commits only)"}, last commit ${sb.last_commit ? `${sb.last_commit}${sb.last_commit_at ? ` at ${sb.last_commit_at}` : ""}` : "none"}, last push ${sb.last_push_at ?? "none"}, ${plural(sb.pending_operations, "pending operation")}, ${plural(sb.pending_commits, "commit")} to push${sb.last_error ? `; last error: ${sb.last_error}${sb.next_retry_at ? ` (retry at ${sb.next_retry_at})` : ""}${sb.hint ? `; ${sb.hint}${sb.docs ? ` (${sb.docs})` : ""}` : ""}` : ""}`,
  );
  const f = r.change_feed;
  line("changes", f.running ? `feed running, last seq ${f.head}` : `feed NOT RUNNING: ${f.reason}`);
  line("webhooks", `${r.webhooks.count}${r.webhooks.failing.length ? ` (${r.webhooks.failing.length} failing)` : ""}`);
  for (const w of r.webhooks.failing) out.push(`  ! ${w.id} ${w.url_host}: ${plural(w.failures, "failed attempt")}, retried with backoff${w.last_error ? `; last error: ${w.last_error}` : ""}`);
  const reads = (t: EngineStatus["tokens"][number]) => (t.read ? [`read ${t.read.length ? t.read.join(", ") : "nothing"}`] : []);
  const perms = (t: EngineStatus["tokens"][number]) => [...reads(t), t.write.length ? `write ${t.write.join(", ")}` : t.read ? "no write" : "read only", ...(t.ddl ? ["ddl"] : []), ...(t.maintain ? ["maintain"] : [])].join(", ");
  line("tokens", r.tokens.length ? r.tokens.map((t) => `${t.name} (${perms(t)})`).join("; ") : "owner only");
  const h = r.hand_edits;
  line(
    "hand edits",
    !h.checked
      ? `not checked: ${h.reason}`
      : `${plural(h.edits!, "hand edit")} in the last ${h.window_hours} h${h.rows ? `; ${h.rows === 1 ? "1 row breaks" : `${h.rows} rows break`} the tables' rules (${plural(h.violations!, "violation")})` : ", none breaking the tables' rules"}`,
  );
  for (const x of h.latest ?? []) out.push(`  ! ${x.path}${x.table ? ` (${x.table})` : ""}: ${x.message}${x.violations > 1 ? ` (+${x.violations - 1} more)` : ""}`);
  const lg = r.logs;
  line("logs", [lg.folder ? `files ${lg.folder}` : "files off", ...(lg.console_log ? [`console ${lg.console_log}`] : []), ...(lg.telemetry ? [`telemetry ${lg.telemetry}`] : [])].join(", "));
  if (r.problems.length) out.push("problems:", ...r.problems.map((p) => `  - ${p}`));
  return out.join("\n");
}

/** `datanotes status` (the command line is in `cli.ts`): prints the report, returns the exit code. */
export async function main(argv: string[], deps: StatusDeps & { env?: NodeJS.ProcessEnv; write?: (text: string) => void } = {}): Promise<number> {
  const o = { ...parseStatusArgs(argv, deps.env), ...(deps.env ? { env: deps.env } : {}) };
  const { code, report } = await collectStatus(o, deps);
  (deps.write ?? ((t) => process.stdout.write(t)))(`${o.json ? JSON.stringify({ exit_code: code, ...report }, null, 2) : formatStatus(report)}\n`);
  return code;
}
