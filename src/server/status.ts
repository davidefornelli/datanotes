/**
 * The engine's health at a glance (`POST /datanotes/status/`, owner only; `datanotes status`
 * prints it): the engine, the database, git sync, the store backup, the change feed, webhooks, named tokens, recent hand
 * edits that break the tables' rules, and where the logs go. `healthy` is false when something
 * needs attention; `problems` says what, in words.
 *
 * Cheap by design: it reads what the engine already knows (the metastore cache, the journal's
 * newest files, the change feed's day files) and checks nothing again. Hand edits are judged by
 * the checks the change feed ran when it recorded them (`ChangeFeed.handEditViolations`), not by
 * a check_table of every table. No token or secret is ever part of it: webhooks show their URL's
 * host only, tokens their names and permissions, telemetry its collector's origin.
 */

import type { App } from "../core/host";
import type { ChangeFeed, HandEditSummary } from "../core/change-feed";
import { historyEnabled } from "../core/transaction-log";
import { journalActivity, type JournalActivity } from "../core/journal";
import { catalogTables, catalogViews, loadMetastore, metastorePath } from "../core/metastore";
import type { DatanotesSettings } from "../core/settings";
import { storePath, storeRead } from "../core/store";
import { databaseMoves, type DatabaseMove } from "../core/database-move";
import { messageOf } from "../core/message";
import type { PublicToken } from "./tokens";
import { publicView, type PublicWebhook, type Webhook } from "./webhooks";

/** How far back the journal and the hand edits are looked at. */
export const STATUS_WINDOW_HOURS = 24;

/** Git sync as the host runs it (`src/node/git-sync.ts`). */
export interface GitStatusView {
  enabled: boolean;
  repo?: string;
  lastRun?: string;
  lastCommit?: string;
  lastPush?: string;
  blocked?: string;
  pendingOperations: number;
}

/** The store backup as the host runs it (`src/node/store-backup.ts`). */
export interface StoreBackupView {
  enabled: boolean;
  /** The seconds between two looks for changes (a commit when something changed). */
  every: number;
  /** Without credentials; null: commits only. */
  remote: string | null;
  lastCommit?: string;
  lastCommitAt?: string;
  lastPush?: string;
  pendingOperations: number;
  pendingCommits: number;
  lastError?: string;
  nextRetry?: string;
  /** How to fix `lastError` when a person must, and where to read more. */
  hint?: string;
  docs?: string;
}

/** What only the host knows: how it watches the vault, its files, git sync, the store backup. */
export interface HostStatus {
  pid?: number;
  /** The machine's name. */
  hostName?: string;
  vault?: string;
  watch?: string;
  settingsFile?: string;
  /** The engine's store folder (journal, transaction log, tokens, logs). */
  store?: string;
  /** `--log`: where console output goes. */
  logFile?: string;
  /** Null when git sync is off. */
  git?: GitStatusView | null;
  /** Null when the store backup is off. */
  storeBackup?: StoreBackupView | null;
}

export interface StatusInput {
  app: App;
  settings: DatanotesSettings;
  version: string;
  startedAt: Date;
  http: { host: string; port: number | null };
  feed: ChangeFeed | null;
  /** Why the change feed is not running (null while it runs, or when not known). */
  feedProblem: string | null;
  /** The webhooks the dispatcher runs; null when it is not running (they are read from the store). */
  webhooks: PublicWebhook[] | null;
  tokens: PublicToken[];
  host: HostStatus | null;
  /** The OTLP endpoint logs are sent to, null when telemetry is off. */
  telemetryEndpoint: string | null;
  now?: Date;
}

export interface EngineStatus {
  healthy: boolean;
  problems: string[];
  engine: {
    version: string;
    pid: number | null;
    host_name: string | null;
    started_at: string;
    uptime_s: number;
    http: { host: string; port: number | null };
    watch: string | null;
    vault: string | null;
    settings_file: string | null;
    /** The engine's store folder (null: the host keeps none of its own). */
    store: string | null;
    /** The database's id (`id` in metastore.yaml); null when the host has none. */
    database_id: string | null;
    database_folder: string;
  };
  database: {
    metastore: string;
    /** The last move of the database folder (configure_database, or by hand), if any. */
    moved?: DatabaseMove;
    readable: boolean;
    /** Why it is not readable: not found, or the parse error. */
    error?: string;
    tables: number;
    views: number;
    history_tables: number;
    journal: { window_hours: number; operations: number; last: JournalActivity["last"] };
  };
  git_sync: { enabled: boolean; repo?: string; last_run_at?: string; last_commit?: string; last_push_at?: string; blocked?: string; pending_operations: number } | null;
  /** The store's git backup; null when it is off. */
  store_backup: {
    enabled: boolean;
    interval_s: number;
    remote: string | null;
    last_commit?: string;
    last_commit_at?: string;
    last_push_at?: string;
    pending_operations: number;
    pending_commits: number;
    last_error?: string;
    next_retry_at?: string;
    hint?: string;
    docs?: string;
  } | null;
  change_feed: { running: boolean; reason?: string; head: number | null };
  webhooks: { count: number; failing: { id: string; url_host: string; failures: number; last_error?: string; last_delivery?: string; cursor: number }[] };
  /** `read`: the read patterns of a token that may not read every table (absent: every table). */
  tokens: { name: string; read?: string[]; write: string[]; ddl: boolean; maintain: boolean; last_seen: string | null }[];
  hand_edits: { window_hours: number; checked: boolean; reason?: string } & Partial<HandEditSummary>;
  logs: { folder: string | null; console_log: string | null; telemetry: string | null };
}

/** A URL's host or origin: never its path, query or credentials. */
function urlPart(url: string, part: "host" | "origin"): string {
  try {
    return new URL(url)[part];
  } catch {
    return "(invalid URL)";
  }
}

/** The webhooks kept in the store, as the dispatcher would list them (when it is not running). */
async function storedWebhooks(app: App, s: DatanotesSettings): Promise<PublicWebhook[]> {
  try {
    const text = await storeRead(app, storePath("webhooks.json"));
    return text ? (JSON.parse(text) as Webhook[]).map(publicView) : [];
  } catch {
    return [];
  }
}

export async function engineStatus(i: StatusInput): Promise<EngineStatus> {
  const s = i.settings;
  const now = i.now ?? new Date();
  const since = now.getTime() - STATUS_WINDOW_HOURS * 3600_000;
  const problems: string[] = [];

  let model = null;
  let metaError: string | undefined;
  try {
    model = (await loadMetastore(i.app, s))?.model ?? null;
    if (!model) metaError = "not found (no tables yet)";
  } catch (e) {
    metaError = `cannot be read: ${messageOf(e)}`;
    problems.push(`metastore.yaml ${metaError}`);
  }
  const tables = model ? catalogTables(model) : [];
  const journal = await journalActivity(i.app, s, since);
  const moves = await databaseMoves(i.app);
  const moved = moves[moves.length - 1];

  const git = i.host?.git ?? null;
  if (git?.blocked) problems.push(`git sync blocked: ${git.blocked}`);
  const backup = i.host?.storeBackup ?? null;
  if (backup?.lastError) problems.push(`store backup failing: ${backup.lastError}`);

  const feedReason = i.feed ? undefined : (i.feedProblem ?? "not started");
  if (!i.feed) problems.push(`change feed not running: ${feedReason}`);

  const hooks = i.webhooks ?? (await storedWebhooks(i.app, s));
  const failing = hooks.filter((w) => w.status === "failing");
  for (const w of failing) problems.push(`webhook ${w.id} (${urlPart(w.url, "host")}) failing: ${w.last_error ?? "no answer"}`);

  let handEdits: EngineStatus["hand_edits"];
  if (!i.feed) handEdits = { window_hours: STATUS_WINDOW_HOURS, checked: false, reason: "the change feed is not running" };
  else {
    try {
      handEdits = { window_hours: STATUS_WINDOW_HOURS, checked: true, ...(await i.feed.handEditViolations(since)) };
      const { rows, violations } = handEdits as HandEditSummary;
      if (rows > 0) problems.push(`${rows === 1 ? "1 row edited by hand breaks" : `${rows} rows edited by hand break`} the tables' rules (${violations} violation${violations === 1 ? "" : "s"})`);
    } catch (e) {
      handEdits = { window_hours: STATUS_WINDOW_HOURS, checked: false, reason: messageOf(e) };
    }
  }

  return {
    healthy: problems.length === 0,
    problems,
    engine: {
      version: i.version,
      pid: i.host?.pid ?? null,
      host_name: i.host?.hostName ?? null,
      started_at: i.startedAt.toISOString(),
      uptime_s: Math.max(0, Math.round((now.getTime() - i.startedAt.getTime()) / 1000)),
      http: i.http,
      watch: i.host?.watch ?? null,
      vault: i.host?.vault ?? null,
      settings_file: i.host?.settingsFile ?? null,
      store: i.host?.store ?? null,
      database_id: s.databaseId || null,
      database_folder: s.databaseFolder,
    },
    database: {
      metastore: metastorePath(s),
      ...(moved ? { moved } : {}),
      readable: !!model,
      ...(metaError ? { error: metaError } : {}),
      tables: tables.length,
      views: model ? catalogViews(model).length : 0,
      history_tables: model ? tables.filter((t) => historyEnabled(model, t.entry)).length : 0,
      journal: { window_hours: STATUS_WINDOW_HOURS, operations: journal.recent, last: journal.last },
    },
    git_sync: git
      ? {
          enabled: git.enabled,
          ...(git.repo ? { repo: git.repo } : {}),
          ...(git.lastRun ? { last_run_at: git.lastRun } : {}),
          ...(git.lastCommit ? { last_commit: git.lastCommit } : {}),
          ...(git.lastPush ? { last_push_at: git.lastPush } : {}),
          ...(git.blocked ? { blocked: git.blocked } : {}),
          pending_operations: git.pendingOperations,
        }
      : null,
    store_backup: backup
      ? {
          enabled: backup.enabled,
          interval_s: backup.every,
          remote: backup.remote,
          ...(backup.lastCommit ? { last_commit: backup.lastCommit } : {}),
          ...(backup.lastCommitAt ? { last_commit_at: backup.lastCommitAt } : {}),
          ...(backup.lastPush ? { last_push_at: backup.lastPush } : {}),
          pending_operations: backup.pendingOperations,
          pending_commits: backup.pendingCommits,
          ...(backup.lastError ? { last_error: backup.lastError } : {}),
          ...(backup.nextRetry ? { next_retry_at: backup.nextRetry } : {}),
          ...(backup.hint ? { hint: backup.hint } : {}),
          ...(backup.docs ? { docs: backup.docs } : {}),
        }
      : null,
    change_feed: { running: !!i.feed, ...(feedReason ? { reason: feedReason } : {}), head: i.feed ? i.feed.lastSeq : null },
    webhooks: {
      count: hooks.length,
      failing: failing.map((w) => ({
        id: w.id,
        url_host: urlPart(w.url, "host"),
        failures: w.failures,
        ...(w.last_error ? { last_error: w.last_error } : {}),
        ...(w.last_delivery ? { last_delivery: w.last_delivery } : {}),
        cursor: w.cursor,
      })),
    },
    tokens: i.tokens.map((t) => ({ name: t.name, ...(t.read.includes("*") ? {} : { read: t.read }), write: t.write, ddl: t.ddl, maintain: t.maintain === true, last_seen: t.last_seen ?? null })),
    hand_edits: handEdits,
    logs: {
      folder: s.fileLogEnabled ? (i.host?.store ? `${i.host.store}${i.host.store.includes("\\") ? "\\" : "/"}logs` : storePath("logs")) : null,
      console_log: i.host?.logFile ?? null,
      telemetry: i.telemetryEndpoint ? urlPart(i.telemetryEndpoint, "origin") : null,
    },
  };
}
