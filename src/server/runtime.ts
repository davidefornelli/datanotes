/**
 * The engine at work on a vault (the headless service): it follows vault events to keep `metastore.yaml` loaded, logs hand edits in
 * the transaction log, adopts notes created in table folders, recomputes generated columns,
 * mirrors inverse links, keeps the semantic index current, maintains the hidden store, sends logs
 * and runs the HTTP server.
 *
 * The host gives it the vault (`App`), the settings and the I/O it cannot do itself (HTTP for
 * embeddings and logs, secrets).
 */

import type { App, EventRef, TAbstractFile, TFile } from "../core/host";
import { adoptCreatedNote } from "../core/auto-adopt";
import { AutoRecompute } from "../core/auto-recompute";
import type { Transport } from "../core/embeddings";
import { emptyResult, engineWriting, logExternalEdits } from "../core/engine";
import { bumpVaultGeneration, invalidateFiles } from "../core/file-cache";
import { appendLog, pruneLogs } from "../core/file-log";
import { InverseWatcher } from "../core/inverse";
import { compactJournal } from "../core/journal";
import { logLockActivity, setCheckpointRunner, verifyCurrentStates, warmLoggedStates, withLogLock, writeDueCheckpoints } from "../core/transaction-log";
import { loadMetastore, METASTORE_FILE, metastorePath } from "../core/metastore";
import { metastoreId } from "../core/database-id";
import { recordDatabaseMove, type RecordedMove } from "../core/database";
import { settleVault, setVaultSettler, type VaultSettler } from "../core/vault-settle";
import { createPublicApi, type DatanotesPublicApi } from "../core/public-api";
import { recomputeColumns, syncRelations } from "../core/rows";
import { SemanticIndex } from "../core/semantic";
import { DocsSemanticIndex } from "../core/docs-semantic";
import { DocsError, openDocs, type DocsLibrary } from "../api/docs";
import type { DatanotesSettings } from "../core/settings";
import { FileLogger, NOOP_TELEMETRY, setTelemetry, TeeTelemetry, telemetry } from "../core/telemetry";
import { OtlpSink, resolveOtlp } from "./otlp-sink";
import { engineResource, installTracing, resolveTraces, TraceSink } from "./tracing";
import { job } from "../core/tracing";
import { traceVaultIo } from "../core/vault-io-tracing";
import type { OtlpOptions } from "../api/otlp";
import { newToken, HttpApiServer } from "./http-server";
import { createHandlers, dispatch, type Handler } from "./rest";
import { checkIndexAfter } from "../core/index-check";
import { SessionIdentities } from "./identities";
import { currentActor, type Actor } from "../core/actor";
import type { ToolCallRecord } from "../api/client";
import { cutRecorded, isPlainObject, RECORDED_CHARS, redactToolCall, summarizeRecorded } from "../api/redact";
import { ChangeFeed } from "../core/change-feed";
import { externalRename } from "../core/hand-moves";
import { WebhookDispatcher } from "./webhooks";
import { engineStatus, type HostStatus } from "./status";
import { scopeOf, TokenRegistry, tokenNameOf } from "./tokens";
import { ExtensionRegistry } from "./extensions";
import { OperationScheduler } from "./scheduler";
import { ReadCache } from "./read-cache";
import { openApiDocument } from "./openapi";
import { messageOf } from "../core/message";
import { guide } from "../core/hints";

/** The routes an MCP server reports its agents on. */
const REPORT_HINT = guide(`Send {"session", "model", "harness"} to sessions/identify/ and {"tool", "args", "ok", ...} to tool-calls/record/; DatanotesClient.recordToolCall does it.`, "reportAgents");

/** Quiet time after the last vault change before hand edits are logged. */
const EXTERNAL_EDIT_DELAY_MS = 3000;
/** How often the transaction log's current states are checked against the vault, and after how long without a write. */
const LOG_CHECK_EVERY_MS = 10 * 60_000;
const LOG_CHECK_IDLE_MS = 60_000;
/** How often the store's housekeeping runs while the engine runs (and once at start). */
const MAINTENANCE_EVERY_MS = 24 * 3600_000;
/** Quiet time after the last note change before the semantic index catches up. */
const SEMANTIC_DELAY_MS = 10000;
/** Wait after the metastore went away before looking for the database folder elsewhere. */
const RELOCATE_DELAY_MS = 1000;

export interface RuntimeOptions {
  app: App;
  getSettings(): DatanotesSettings;
  saveSettings(): Promise<void>;
  /** HTTP for embedding requests. */
  transport: Transport;
  /** HTTP POST of OTLP log batches. */
  /** The process environment, for the standard OpenTelemetry variables (`OTEL_*`). */
  env?: Record<string, string | undefined>;
  /** Injected in tests: how OTLP requests are sent (default fetch). */
  otlpSend?: OtlpOptions["send"];
  /** The embedding API key (from the host's secret store), if any. */
  embeddingKey(): string | undefined;
  version: string;
  /** `service.instance` of the logs, and the log files' source (e.g. "service"). */
  hostName: string;
  /** Can this host open a TCP server? */
  canServeHttp: boolean;
  /** Address the HTTP server listens on (default 127.0.0.1; 0.0.0.0 in a container). */
  httpHost?: string;
  /** Port of the HTTP server for this run, over the setting `httpServerPort` (`--port`; 0: any free port). */
  httpPort?: number;
  /** The docs the engine serves (`GET /datanotes/manual/`) and indexes for search_docs (default: the package's own). */
  docs?: DocsLibrary;
}

export class EngineRuntime {
  readonly semantic: SemanticIndex;
  /** The vector index of the docs, for the hybrid search of search_docs. */
  readonly docsIndex: DocsSemanticIndex;
  readonly api: DatanotesPublicApi;
  /** Named tokens and their permissions. */
  readonly tokens: TokenRegistry;
  /** The extensions installed in the database: their records. */
  readonly extensions: ExtensionRegistry;
  /** Models agents reported (start_session), kept across HTTP server restarts. */
  readonly identities = new SessionIdentities();
  /** Last start error of the HTTP server (shown in the settings). */
  httpServerError: string | null = null;
  /** The same error, with its guidance (a {@link ListenError}: its `code` says why). */
  httpServerFailure: Error | null = null;
  private httpServer: HttpApiServer | null = null;
  private httpServerPort: number | null = null;
  private readonly recompute: AutoRecompute;
  private readonly inverse: InverseWatcher;
  private refs: { target: { offref?(ref: EventRef): void }; ref: EventRef }[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private semanticTimer: ReturnType<typeof setTimeout> | undefined;
  private semanticFull = false;
  private logTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private feed: ChangeFeed | null = null;
  private feedStarting: Promise<void> | null = null;
  private webhooks: WebhookDispatcher | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** The idle check of the transaction log's current states (see {@link checkLogStates}). */
  private logCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** The store's housekeeping, once a day ({@link maintainStore}). */
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Checkpoints of the transaction log waiting to be written (a job runs them after the writes that made them due). */
  private checkpointsQueued = false;
  /** Background work started without a caller to wait for it: `stop()` waits for it. */
  private tasks = new Set<Promise<void>>();
  private readonly startedAt = new Date();
  /** Why the change feed is not running (the last failure to read the metastore or to start it). */
  private feedProblem: string | null = null;
  private hostStatus: (() => HostStatus) | null = null;
  /** How the host stops the engine when asked over HTTP (`/stop/`); null: it cannot. */
  private hostStop: (() => void) | null = null;
  /** Write priority of the operations (settings `writePriority`, `writePriorityMaxWaitMs`). */
  readonly scheduler: OperationScheduler;
  /** Answers of repeated reads, while the engine follows the vault (setting `readCacheMaxBytes`). */
  private cache: ReadCache | null = null;

  /** The vault this runtime serves. */
  get app(): App {
    return this.o.app;
  }

  constructor(private readonly o: RuntimeOptions) {
    const app = o.app;
    this.semantic = new SemanticIndex(app, o.getSettings, o.transport, o.embeddingKey);
    // the docs are found on first use, as GET /datanotes/manual/ finds them
    this.docsIndex = new DocsSemanticIndex(app, o.getSettings, o.transport, o.embeddingKey, () => {
      const docs = o.docs ?? openDocs();
      return { version: docs.version(), sections: docs.sections() };
    });
    this.api = createPublicApi(app, o.getSettings, o.saveSettings, this.semantic, () => this.feed, () => this.webhooks);
    this.tokens = new TokenRegistry({ app, getSettings: o.getSettings });
    this.extensions = new ExtensionRegistry({ app, getSettings: o.getSettings });
    this.scheduler = new OperationScheduler(() => {
      const s = o.getSettings();
      return { enabled: s.writePriority, maxReadWaitMs: s.writePriorityMaxWaitMs };
    });
    // A recompute or a link mirror due while the database folder is looked for is dropped: the
    // move, when it is one, recomputes every generated column in bulk, and the links are read anew.
    this.recompute = new AutoRecompute(
      app,
      o.getSettings,
      (a, settings, input) => (this.relocation ? Promise.resolve(emptyResult("recompute_columns", false)) : recomputeColumns(a, settings, input)),
      (path, e) => telemetry().log("WARN", "datanotes recompute failed", { path, error: messageOf(e) }),
    );
    this.inverse = new InverseWatcher(app, o.getSettings, async (changes) => {
      if (this.relocation) return;
      try {
        const r = await syncRelations(app, o.getSettings(), changes);
        if (r && !r.ok) telemetry().log("WARN", "datanotes could not mirror links", { conflicts: r.conflicts.length, violating_rows: r.violations.length, failed: r.failed.length });
      } catch (e) {
        telemetry().log("WARN", "datanotes link mirroring failed", { error: messageOf(e) });
      }
    });
  }

  /** What the host adds to the status (`/status/`): how it watches the vault, its files, git sync. */
  setHostStatus(fn: (() => HostStatus) | null): void {
    this.hostStatus = fn;
  }

  /**
   * How the host stops the engine (the service: a graceful stop, then the process exits), for
   * `POST /datanotes/stop/` (`datanotes stop`). Set it before the HTTP server starts: the
   * route is served only when the host can stop.
   */
  setHostStop(fn: (() => void) | null): void {
    this.hostStop = fn;
  }

  /**
   * The first step of a graceful stop: new requests are answered 503 (the engine is stopping), long
   * polls of the change feed answer at once, and the requests under way are let finish, at most
   * `timeoutMs`. True when none is left.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.feed?.endWaits();
    return this.httpServer ? this.httpServer.drain(timeoutMs) : true;
  }

  /** The change feed, while the engine follows the vault. */
  get changeFeed(): ChangeFeed | null {
    return this.feed;
  }

  /** Route handlers over this runtime's vault and index (for the HTTP server or the Local REST API). */
  handlers(): Record<string, Handler> {
    const handled = createHandlers(this.o.app, this.o.getSettings, this.o.saveSettings, this.semantic, this.api, {
      scheduler: this.scheduler,
      cache: () => this.cache,
      scope: () => this.cacheScope(),
    });
    // DATANOTES_INDEX_CHECK=1 (index-check.ts): the indexes are checked against the vault after every operation
    const base: Record<string, Handler> = {};
    for (const [route, h] of Object.entries(handled)) {
      base[route] = async (body) => {
        const res = await h(body);
        await checkIndexAfter(this.o.app, this.o.getSettings(), route);
        return res;
      };
    }
    const openapi: Handler = async () => ({ status: 200, json: openApiDocument(this.o.version) });
    return {
      ...base,
      ...this.tokens.handlers(),
      ...this.extensions.handlers(),
      // an MCP server tells the engine the model behind an agent's session (later calls carry it)
      "/sessions/identify/": async (body) => {
        const session = typeof body.session === "string" ? body.session.trim() : "";
        if (!session) return { status: 400, json: { error: `"session" is required`, ...REPORT_HINT } };
        this.identities.set(session, { model: body.model, harness: body.harness });
        return { status: 200, json: { ok: true } };
      },
      // the docs ranked by meaning: search_docs fuses this ranking with its own, by words
      "/manual/search/": async (body) => {
        try {
          return { status: 200, json: await this.docsIndex.search(body.query, body.limit ?? undefined) };
        } catch (e) {
          if (!(e instanceof DocsError)) throw e;
          return { status: 503, json: { error: e.message, hint: e.hint, docs: e.docs } };
        }
      },
      // an MCP server reports the tool calls of its agents (the change feed's tool_call events)
      "/tool-calls/record/": async (body) => {
        if (typeof body.tool !== "string" || !body.tool) return { status: 400, json: { error: `"tool" is required`, ...REPORT_HINT } };
        const actor = currentActor();
        // answered once the event is in the feed: a read right after sees it
        await this.recordToolCall({
          tool: body.tool,
          args: body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {},
          ok: body.ok === true,
          duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : 0,
          value: body.value,
          served_by: typeof body.served_by === "string" ? body.served_by : "engine",
          ...(typeof body.session === "string" ? { session: body.session } : {}),
          ...(typeof body.result_chars === "number" ? { result_chars: body.result_chars } : {}),
          ...(typeof body.result_tokens === "number" ? { result_tokens: body.result_tokens } : {}),
          ...(isPlainObject(body.summary) ? { summary: body.summary } : {}),
          ...(actor ? { actor } : {}),
        });
        // the reporter may send the value cut, with the result's summary (redact.ts cutToolCall)
        return { status: 200, json: { ok: true, takes_summary: true } };
      },
      "/openapi/": openapi,
      "/openapi.json/": openapi,
      // the engine's health (owner only: OWNER_ADMIN_ROUTES)
      "/status/": async () => {
        const s = this.o.getSettings();
        const status = await engineStatus({
          app: this.o.app,
          settings: s,
          version: this.o.version,
          startedAt: this.startedAt,
          http: { host: this.o.httpHost ?? "127.0.0.1", port: this.httpServerPort },
          feed: this.feed,
          feedProblem: this.feedProblem,
          webhooks: this.webhooks?.list() ?? null,
          tokens: this.tokens.list(),
          host: this.hostStatus?.() ?? null,
          telemetryEndpoint: resolveOtlp(s, this.o.env ?? {}, { serviceVersion: this.o.version })?.endpoint ?? null,
        });
        return { status: 200, json: status };
      },
      // a graceful stop, asked by `datanotes stop` (owner only: OWNER_ADMIN_ROUTES); answered
      // first, then the host stops: the requests under way finish, new ones are refused
      ...(this.hostStop
        ? {
            "/stop/": async () => {
              const stop = this.hostStop!;
              setTimeout(stop, 0);
              telemetry().log("INFO", "datanotes stop requested over HTTP", {});
              return { status: 200, json: { ok: true, stopping: true, pid: this.hostStatus?.()?.pid ?? null } };
            },
          }
        : {}),
    };
  }

  /**
   * An agent's tool call, as a change-feed event (secrets removed, long values cut); settled once
   * it is recorded. The feed is kept in the store, which the store backup commits: no secret.
   */
  private recordToolCall(given: ToolCallRecord & { actor?: Actor }): Promise<void> {
    const call = { ...given, ...redactToolCall(given.tool, given.args, given.value) };
    // a result object gives its own summary; a value the reporter cut, the summary it sent (its secrets removed too)
    const summary = !call.ok
      ? undefined
      : isPlainObject(call.value)
        ? summarizeRecorded(call.value)
        : given.summary
          ? summarizeRecorded(redactToolCall(given.tool, {}, given.summary).value as Record<string, unknown>)
          : undefined;
    const recorded = this.feed?.recordToolCall(
      {
        tool: call.tool,
        args: Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, cutRecorded(v, RECORDED_CHARS.arg)])),
        ok: call.ok,
        durationMs: call.duration_ms,
        value: cutRecorded(call.value, RECORDED_CHARS.value),
        ...(summary ? { summary } : {}),
        servedBy: call.served_by,
        ...(call.session ? { session: call.session } : {}),
        ...(call.result_chars !== undefined ? { resultChars: call.result_chars } : {}),
        ...(call.result_tokens !== undefined ? { resultTokens: call.result_tokens } : {}),
      },
      call.actor,
    );
    telemetry().log("INFO", "datanotes tool call", {
      tool: call.tool,
      ok: call.ok,
      duration_ms: call.duration_ms,
      served_by: call.served_by,
      result_chars: call.result_chars ?? 0,
      result_tokens: call.result_tokens ?? 0,
      harness: call.actor?.harness ?? "",
      model: call.actor?.model ?? "",
      session: call.session ?? "",
    });
    return recorded ?? Promise.resolve();
  }

  /**
   * Logs to an OpenTelemetry collector (when configured) and to `logs/` in the engine's store;
   * traces to the same collector (tracing.ts). The tracer is installed only while traces are on:
   * off, every span helper is a single check.
   */
  startTelemetry(): void {
    const s = this.o.getSettings;
    const base = () => ({ serviceVersion: this.o.version, resource: engineResource(s(), this.o.hostName) });
    // asked for every record: the resource is built only while logs are exported
    const logger = new OtlpSink(() => resolveOtlp(s(), this.o.env ?? {}, base), this.o.otlpSend);
    // One file per process: two processes never append to the same file.
    const source = this.o.hostName;
    const fileLog = new FileLogger({ enabled: () => s().fileLogEnabled, write: (day, lines) => appendLog(this.o.app, s(), day, lines, source) });
    const tee = new TeeTelemetry([logger, fileLog]);
    setTelemetry(tee);
    this.traces = new TraceSink(() => resolveTraces(s(), this.o.env ?? {}, base()), this.o.otlpSend);
    // vault and store calls are counted on the spans (one check per call while traces are off)
    traceVaultIo(this.o.app);
    this.refreshTracing();
    this.flushTimer = setInterval(() => {
      this.refreshTracing();
      void tee.flush();
      void this.traces?.flush();
    }, 5000);
  }

  private traces: TraceSink | null = null;
  private tracingInstalled = false;

  /** Install the tracer when traces are on, take it away when they are off (settings changed). */
  private refreshTracing(): void {
    const want = this.traces?.current() != null;
    if (want === this.tracingInstalled) return;
    this.tracingInstalled = want;
    installTracing(want ? this.traces : null);
  }

  /** Spans sent to the collector and spans lost (tests, status). */
  get traceExport(): { sent: number; dropped: number } {
    return { sent: this.traces?.sent ?? 0, dropped: this.traces?.dropped ?? 0 };
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  /**
   * Run work in the background: a failure goes to the log, and `stop()` waits for the work to end,
   * so nothing still reads or writes the vault once the runtime has stopped.
   */
  private track(work: Promise<unknown>, what: string): void {
    const task: Promise<void> = work
      .then(() => undefined)
      .catch((e: unknown) => telemetry().log("WARN", `datanotes ${what} failed`, { error: messageOf(e) }))
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private listen(target: { on(name: string, cb: (...a: never[]) => unknown): EventRef; offref?(ref: EventRef): void }, name: string, cb: (...a: never[]) => unknown): void {
    this.refs.push({ target, ref: target.on(name, cb) });
  }

  /** Update the semantic index in the background; failures go to the log and the index status. */
  syncSemanticSoon(delay = SEMANTIC_DELAY_MS, full = false): void {
    if (!this.o.getSettings().semanticEnabled) return;
    if (full) this.semanticFull = true;
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    this.semanticTimer = setTimeout(() => {
      const scan = this.semanticFull;
      this.semanticFull = false;
      job("job semantic_index", (span) => this.semantic.sync({ onlyPending: !scan }).then((r) => {
        span.setAttributes({ "datanotes.embedded": r.embedded, "datanotes.removed": r.removed, "datanotes.failed": r.failed.length });
        return r;
      }))
        .then((r) => {
          if (r.embedded || r.removed || r.failed.length) {
            telemetry().log(r.failed.length ? "WARN" : "INFO", "datanotes semantic index updated", { embedded: r.embedded, removed: r.removed, failed: r.failed.length });
          }
        })
        .catch((e: unknown) => telemetry().log("WARN", "datanotes semantic index update failed", { error: messageOf(e) }))
        // after a full scan (the engine's start), the docs' index: nothing to do when it covers them
        .then(() => (scan && this.started ? this.syncDocsIndex() : undefined));
    }, delay);
  }

  /** Bring the vector index of the docs up to date (search_docs); a failure goes to the log, and to the next searches. */
  private async syncDocsIndex(): Promise<void> {
    try {
      const r = await this.docsIndex.sync();
      if (r.embedded || r.removed) telemetry().log("INFO", "datanotes docs index updated", { version: r.version, embedded: r.embedded, reused: r.reused, removed: r.removed });
    } catch (e) {
      // no docs in this installation (a checkout where they were not built): nothing to index
      if (!(e instanceof DocsError)) telemetry().log("WARN", "datanotes docs index update failed", { error: messageOf(e) });
    }
  }

  /** Start, restart or stop the HTTP server to match the settings. */
  async applyHttpServer(): Promise<void> {
    await this.httpServer?.stop();
    this.httpServer = null;
    this.httpServerPort = null;
    this.httpServerError = null;
    this.httpServerFailure = null;
    const s = this.o.getSettings();
    if (!this.o.canServeHttp) {
      this.httpServerError = "the HTTP server runs on desktop only";
      return;
    }
    if (!s.httpServerToken) {
      s.httpServerToken = newToken();
      await this.o.saveSettings();
    }
    const handlers = this.handlers();
    const guarded = this.tokens.guard(dispatch);
    const server = new HttpApiServer({
      app: this.o.app,
      handlers,
      token: s.httpServerToken,
      port: this.o.httpPort ?? s.httpServerPort,
      version: this.o.version,
      identities: this.identities,
      ...(this.o.httpHost ? { host: this.o.httpHost } : {}),
      changeFeed: () => this.feed,
      tokens: this.tokens,
      // the change stream's events, as the token may read them (a token gone since: nothing)
      readScopeOf: (name) => {
        const t = this.tokens.get(name);
        return t ? scopeOf(t) : { token: name, patterns: [] };
      },
      dispatch: guarded,
      ...(this.o.docs ? { docs: this.o.docs } : {}),
      compression: () => this.o.getSettings().httpCompression,
    });
    try {
      const port = await server.start();
      this.httpServer = server;
      this.httpServerPort = port;
      telemetry().log("INFO", "datanotes HTTP server listening", { port });
    } catch (e) {
      this.httpServerError = messageOf(e);
      this.httpServerFailure = e instanceof Error ? e : new Error(this.httpServerError);
      telemetry().log("WARN", "datanotes HTTP server could not start", { error: this.httpServerError });
    }
  }

  get httpServerRunning(): boolean {
    return this.httpServer !== null;
  }

  /** The port the HTTP server listens on (the one the system chose when the setting is 0); null when it is not running. */
  get httpPort(): number | null {
    return this.httpServerPort;
  }

  /**
   * Housekeeping of the hidden store: journal entries and log files past their retention are
   * dropped.
   */
  async maintainStore(): Promise<void> {
    const app = this.o.app;
    const s = this.o.getSettings();
    try {
      // read and planned without the engine's write lock; applied under it: no operation appends
      // meanwhile, no store backup commits half of it
      const compacted = await compactJournal(app, s, new Date(), (fn) => withLogLock(app, fn));
      const logs = await pruneLogs(app, s);
      if (compacted.dropped > 0 || compacted.blobsRemoved > 0 || logs.length > 0) {
        telemetry().log("INFO", "datanotes store compacted", { dropped: compacted.dropped, blobs_removed: compacted.blobsRemoved, logs_removed: logs.length });
      }
    } catch (e) {
      telemetry().log("WARN", "datanotes store maintenance failed", { error: messageOf(e) });
    }
  }

  /** The read cache, while the engine follows the vault (null otherwise). */
  get readCache(): ReadCache | null {
    return this.cache;
  }

  /**
   * Who reads, for the read cache: the owner, or a named token with its permissions (an answer
   * is never shared between tokens, nor kept across a change of a token's permissions).
   */
  private cacheScope(): string {
    const name = tokenNameOf(currentActor());
    if (!name) return "owner";
    const t = this.tokens.get(name);
    return JSON.stringify([name, t?.write ?? null, t?.ddl ?? null, t?.maintain ?? null, t?.autolink ?? null, t?.read ?? null]);
  }

  /** Follow the vault (call once the vault is indexed: Obsidian's layout-ready, or after opening). */
  async start(opts: { http?: boolean } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    const app = this.o.app;
    const s = this.o.getSettings;
    // the read cache follows the vault's events from here on: it knows when an answer is stale
    this.cache = new ReadCache(app, s);
    // The metastore cache backs sync readers (listTables, row discovery): keep it current. The
    // change feed starts with the first of these reads that succeeds (see startFeed).
    const refreshMetastore = () =>
      loadMetastore(app, s())
        .then(() => {
          this.inverse.init(); // remember the rows' inverse links (again only when their tables changed)
          return this.startFeed();
        })
        .catch((e: unknown) => {
          this.feedProblem = `${METASTORE_FILE} cannot be read: ${messageOf(e)}`;
          telemetry().log("WARN", `datanotes could not read ${METASTORE_FILE}`, { error: messageOf(e) });
        });
    // Any create, delete or rename of the metastore re-reads it too, not only an edit (a git checkout
    // or a sync tool can replace the file): the cache follows the file. A text that cannot be
    // parsed keeps the last good one in the cache (and the WARN above).
    const schemaFile = (path: string) => path === metastorePath(s());
    this.refreshMetastore = refreshMetastore;
    // Hand edits of rows and of metastore.yaml become EXTERNAL_EDIT commits in the transaction log.
    const logSoon = () => {
      if (this.logTimer) clearTimeout(this.logTimer);
      this.logTimer = setTimeout(() => {
        this.logTimer = undefined;
        // while the database folder is looked for, its rows are neither gone nor moved yet
        if (this.relocation) {
          logSoon();
          return;
        }
        this.track(job("job hand_edits_log", () => logExternalEdits(app, s())), "transaction log of hand edits");
      }, EXTERNAL_EDIT_DELAY_MS);
    };
    const watched = (path: string) => schemaFile(path) || path.endsWith(".md");
    // A note created in a table folder (e.g. by Daily Notes) becomes a row of that table.
    const adoptSoon = (path: string) => {
      if (!path.endsWith(".md")) return;
      this.later(600, async () => {
        await this.relocated();
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) return;
        this.track(
          // an adopted note, or one refused with a reason, names its table
          job("job adopt_note", () => adoptCreatedNote(app, s(), file as TFile)).then((r) => {
            if (r.adopted) telemetry().log("INFO", "datanotes adopted new note", { path, table: r.table! });
            else if (r.reason) telemetry().log("WARN", "datanotes could not adopt new note", { path, table: r.table!, reason: r.reason });
          }),
          `adopt of ${path}`,
        );
      });
    };
    const v = app.vault as unknown as { on(name: string, cb: (...a: never[]) => unknown): EventRef; offref?(ref: EventRef): void };
    const mc = app.metadataCache as unknown as { on(name: string, cb: (...a: never[]) => unknown): EventRef; offref?(ref: EventRef): void };

    this.listen(v, "modify", ((f: TAbstractFile) => {
      invalidateFiles(app, [f.path]);
      this.semantic.touch(f.path);
      this.syncSemanticSoon();
      if (schemaFile(f.path)) this.track(job("job schema_reload", () => refreshMetastore()), "schema reload");
      if (watched(f.path)) logSoon();
    }) as never);
    this.listen(v, "delete", ((f: TAbstractFile) => {
      invalidateFiles(app, [f.path]);
      this.inverse.onDeleted(f.path);
      this.semantic.forget(f.path);
      this.syncSemanticSoon();
      if (schemaFile(f.path) && !engineWriting(app)) {
        this.metastoreGone();
        this.track(job("job schema_reload", () => refreshMetastore()), "schema reload");
      }
      if (watched(f.path)) logSoon();
    }) as never);
    this.listen(v, "rename", ((f: TAbstractFile, old: string, info?: unknown) => {
      // a rename the host saw on disk is a hand edit, also while the engine writes
      const byHand = !engineWriting(app) || externalRename(info);
      // configure_database root moves it as an engine write, and records the move itself
      if (schemaFile(old) && !schemaFile(f.path) && byHand) this.metastoreGone();
      invalidateFiles(app, [f.path, old]);
      this.inverse.onRenamed(old, f.path);
      this.semantic.forget(old);
      this.semantic.touch(f.path);
      this.syncSemanticSoon();
      if ("extension" in f && !this.relocation && byHand) this.recompute.onRenamed(f as TFile, old);
      if (schemaFile(f.path) || schemaFile(old)) this.track(job("job schema_reload", () => refreshMetastore()), "schema reload");
      if (watched(f.path) || watched(old)) logSoon();
      // A note moved into a table folder by hand becomes a row of that table, as one created there.
      if (byHand) adoptSoon(f.path);
    }) as never);
    this.listen(v, "create", ((f: TAbstractFile) => {
      invalidateFiles(app, [f.path]);
      this.semantic.touch(f.path);
      this.syncSemanticSoon();
      if (schemaFile(f.path)) this.track(job("job schema_reload", () => refreshMetastore()), "schema reload");
      if (watched(f.path)) logSoon();
      adoptSoon(f.path);
    }) as never);
    // Links are re-resolved after edits: the link graph rebuilds on its next use.
    this.listen(mc, "resolved", (() => bumpVaultGeneration(app)) as never);
    this.listen(mc, "changed", ((f: TFile) => {
      bumpVaultGeneration(app);
      if (!this.followsEdits()) return;
      this.recompute.onChanged(f);
      this.inverse.onChanged(f.path);
    }) as never);

    await refreshMetastore(); // and the change feed
    if (!this.feed) telemetry().log("WARN", `datanotes change feed not running: it starts the next time ${METASTORE_FILE} changes and can be read`);
    await this.tokens.load();
    // The logs are replayed table by table first: the first log of hand edits would otherwise
    // replay them all while holding the write lock, and every write would wait for it.
    this.track(
      job("job transaction_log_warmup", () => warmLoggedStates(app, s(), () => !this.started)).finally(() => {
        if (this.started) logSoon();
      }),
      "transaction log warm-up",
    );
    this.track(job("job store_maintenance", () => this.maintainStore()), "store maintenance");
    this.maintenanceTimer = setInterval(() => this.track(job("job store_maintenance", () => this.maintainStore()), "store maintenance"), MAINTENANCE_EVERY_MS);
    this.maintenanceTimer.unref?.();
    // a checkpoint a write makes due is written after it, as work of its own (the write does not wait)
    setCheckpointRunner(app, () => this.checkpointSoon());
    // The safety net of the log's current states kept between syncs: compared with every row
    // now and then, once the engine has been idle for a while.
    this.logCheckTimer = setInterval(() => this.checkLogStates(logSoon), LOG_CHECK_EVERY_MS);
    this.logCheckTimer.unref?.();
    // Catch up with notes changed while the engine was not running (unchanged notes are skipped).
    this.syncSemanticSoon(5000, true);
    if (opts.http !== false) await this.applyHttpServer();
  }

  /** Write the checkpoints writes made due, in the background (one job for every write meanwhile). */
  private checkpointSoon(): void {
    if (this.checkpointsQueued || !this.started) return;
    this.checkpointsQueued = true;
    this.later(0, () => {
      this.checkpointsQueued = false;
      this.track(job("job transaction_log_checkpoint", () => writeDueCheckpoints(this.o.app, () => !this.started)), "transaction log checkpoint");
    });
  }

  /**
   * The transaction log syncs only the notes changed since the last sync (the vault index's
   * change log). Now and then, when no write ran for {@link LOG_CHECK_IDLE_MS}, the states kept
   * are compared with every row of the vault: a difference (a change no event reported) is
   * logged as a warning, the states are read again in full, and the hand edits are logged.
   * Returns the differences (empty when it did not run).
   */
  async checkLogStates(logSoon: () => void = () => {}, now: number = Date.now()): Promise<string[]> {
    const app = this.o.app;
    const lock = logLockActivity(app);
    if (lock.busy || now - lock.lastEnd < LOG_CHECK_IDLE_MS) return [];
    const check = job("job transaction_log_check", () => withLogLock(app, () => verifyCurrentStates(app, this.o.getSettings(), true)));
    this.track(check, "transaction log check");
    const diffs = await check.catch(() => [] as string[]); // a failure is the tracked task's WARN
    if (diffs.length > 0) {
      telemetry().log("WARN", "datanotes transaction log missed changes: every row read again", { rows: diffs.length, first: diffs.slice(0, 5).join("; ") });
      logSoon();
    }
    return diffs;
  }

  /**
   * Whether a changed note is a hand edit to follow (recompute its generated columns, mirror its
   * links): not while the engine writes (its writes are current), nor while the database folder
   * is looked for (a move of the folder is recomputed in bulk, as one operation).
   */
  private followsEdits(): boolean {
    return !this.relocation && !engineWriting(this.o.app);
  }

  /** Wait until no search for the moved database folder runs (requests wait for it: vault-settle.ts). */
  async relocated(): Promise<void> {
    while (this.relocation) await this.relocation;
  }

  /** The host's way to catch up with the disk (the Node service: its watcher), set by {@link setHostSettler}. */
  private hostSettle: VaultSettler | null = null;

  /**
   * Register the host's catch-up as the vault's settler (vault-settle.ts): every request first
   * applies the changes seen on disk and, when they moved the database folder, waits for the move
   * to be applied as one operation, so no request reads it half repaired.
   */
  setHostSettler(fn: VaultSettler | null): void {
    this.hostSettle = fn;
    setVaultSettler(this.o.app, fn ? async (since) => {
      await fn(since);
      await this.relocated();
    } : null);
  }

  /** Reload the metastore (and start the change feed): set by `start`. */
  private refreshMetastore: (() => Promise<void>) | null = null;
  /** The search for the database folder after its metastore went away, while it runs. */
  relocation: Promise<void> | null = null;
  private relocateWake: (() => void) | null = null;

  /**
   * The metastore went away (deleted, or moved with its folder): the change feed holds the hand
   * edits it sees, and once the vault is quiet the engine looks for the database elsewhere
   * ({@link findMovedDatabase}). Rows of a moved folder are then moved, not deleted.
   */
  private metastoreGone(): void {
    if (this.relocation) return;
    this.feed?.hold();
    const work = new Promise<void>((r) => {
      const t = setTimeout(r, RELOCATE_DELAY_MS);
      // stopping wakes it at once: it then searches nothing
      this.relocateWake = () => {
        clearTimeout(t);
        r();
      };
    })
      .then(() => (this.started ? this.findMovedDatabase() : null))
      .then(() => undefined)
      .finally(() => {
        this.relocation = null;
        this.relocateWake = null;
        this.feed?.release();
      });
    this.relocation = work;
    this.track(work, "search for the moved database folder");
  }

  /**
   * After the metastore went away from the database folder: the one metastore.yaml of the vault
   * with the database's id, elsewhere, is the database folder moved by hand. The move is recorded
   * as `configure_database root` would (recordDatabaseMove: journal, transaction log, links,
   * table paths), the host saves the new place, the change feed moves the rows. Null when the
   * metastore is back, or nothing (or more than one folder) has the id: the rows are gone.
   */
  async findMovedDatabase(): Promise<RecordedMove | null> {
    const app = this.o.app;
    const s = this.o.getSettings();
    // the host's catch-up only: the vault's settler waits for this very search
    if (this.hostSettle) await this.hostSettle();
    else await settleVault(app);
    if (!s.databaseId || app.vault.getAbstractFileByPath(metastorePath(s)) != null) return null;
    const found: string[] = [];
    for (const f of app.vault.getFiles()) {
      const parts = f.path.split("/");
      if (parts[parts.length - 1] !== METASTORE_FILE || parts.includes("node_modules")) continue;
      if (metastoreId(await app.vault.read(f)) === s.databaseId) found.push(parts.slice(0, -1).join("/"));
    }
    if (found.length !== 1) {
      if (found.length > 1) telemetry().log("WARN", "datanotes database folder not found: more than one folder has its id", { folders: found.join(", ") });
      return null;
    }
    const from = s.databaseFolder;
    const to = found[0]!;
    s.databaseFolder = to;
    await this.o.saveSettings();
    // one operation: links, generated columns, journal, history; the change feed hears of it
    const moved = await recordDatabaseMove(app, s, { from, to, by: "hand" });
    // what was scheduled for the rows while they looked moved is done (or not needed) now
    this.recompute.dispose();
    this.inverse.dispose();
    await this.refreshMetastore?.();
    return moved;
  }

  /**
   * Numbered row changes for services connected to the database, and the webhooks on them. The
   * feed reads the rows against the metastore, so it starts with the runtime's first read of the
   * metastore that succeeds: at start or, with no restart, once a metastore that could not be read
   * (broken YAML, a failed read) changes again (edited, created or renamed) and can be read. The
   * reads of other operations do not start it. Until then the feed and webhooks are off.
   */
  private startFeed(): Promise<void> {
    if (!this.started || this.feed) return Promise.resolve();
    this.feedStarting ??= (async () => {
      const app = this.o.app;
      const s = this.o.getSettings;
      const feed = new ChangeFeed(app, s);
      try {
        await feed.start();
        if (!this.started) {
          await feed.stop(); // the runtime stopped meanwhile
          return;
        }
        this.feed = feed;
        this.feedProblem = null;
        const hooks = new WebhookDispatcher(app, s, () => this.feed);
        await hooks.start();
        this.webhooks = hooks;
        this.track(job("job change_feed_prune", () => feed.prune()), "change feed prune");
        this.pruneTimer = setInterval(() => this.track(job("job change_feed_prune", () => feed.prune()), "change feed prune"), 6 * 3600_000);
      } catch (e) {
        if (this.feed !== feed) void feed.stop();
        this.feedProblem = `it could not start: ${messageOf(e)}`;
        telemetry().log("WARN", "datanotes change feed could not start", { error: messageOf(e) });
      }
    })().finally(() => {
      this.feedStarting = null;
    });
    return this.feedStarting;
  }

  /** Stop following the vault; the API keeps working for direct calls. */
  async stop(): Promise<void> {
    this.started = false; // no change feed starts from here on
    await this.feedStarting; // one starting now is stopped below with the rest
    for (const { target, ref } of this.refs) target.offref?.(ref);
    this.refs = [];
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.relocateWake?.();
    // not following the vault any more: no answer can be told stale
    this.cache?.dispose();
    this.cache = null;
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.recompute.dispose();
    this.inverse.dispose();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.logCheckTimer) clearInterval(this.logCheckTimer);
    this.logCheckTimer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    // writes from here on write their checkpoints themselves (the jobs end with the others below)
    setCheckpointRunner(this.o.app, null);
    this.checkpointsQueued = false;
    // Background work already running (a transaction-log pass, a schema reload, store
    // maintenance) ends before the vault is let go; nothing new starts once `started` is false.
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.docsIndex.idle();
    // The hand edits the feed has seen and not compared yet are compared now and their events
    // recorded while the webhooks still run (what they do not deliver before stopping is
    // delivered after the next start, from the stored feed); then the webhooks stop.
    await this.feed?.stop();
    this.feed = null;
    const hooks = this.webhooks;
    this.webhooks = null;
    await hooks?.stop();
    await this.tokens.stop();
    await this.extensions.stop();
    await this.httpServer?.stop();
    this.httpServer = null;
    this.httpServerPort = null;
  }

  /** Stop and flush the logs (host shutdown). */
  async dispose(): Promise<void> {
    await this.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await telemetry().flush();
    setTelemetry(NOOP_TELEMETRY);
    if (this.tracingInstalled) installTracing(null);
    this.tracingInstalled = false;
    await this.traces?.close();
  }
}
