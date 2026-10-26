/**
 * Packs the closed periods on its own (setting `autoPack`): once a day, after the engine has been
 * quiet for {@link AUTO_PACK}`.quietMs` (no write, none under way), `pack_rows` runs on every table
 * with a `pack` option, by the same rules and as silently (no change event, no webhook). A table
 * whose packing fails keeps its rows as they are and is tried again the next day. Only on a host
 * that keeps packs (`App.packs`): the engine service.
 */

import type { App } from "./host";
import { cachedMetastore, catalogTables } from "./metastore";
import { engineWriting } from "./engine";
import { logLockActivity } from "./transaction-log";
import { packRows, type PackRowsResult } from "./pack-rows";
import { readDatabaseConfig } from "./database";
import { wallClock } from "./datetime";
import type { DatanotesSettings } from "./settings";
import { telemetry } from "./telemetry";
import { messageOf } from "./message";

/** How quiet the engine must be before the day's packing, and how often it looks (ms). Tests change them. */
export const AUTO_PACK = { quietMs: 10 * 60_000, checkEveryMs: 60_000 };

type Runner = (app: App, settings: DatanotesSettings, input: { table: string }, opts: { now: Date }) => Promise<PackRowsResult>;

/** What one look of the job did. */
export interface AutoPackRun {
  /** False when it did nothing: off, already done today, the engine not quiet, no packs on this host. */
  ran: boolean;
  /** The tables packed (with rows that went in), by name: packs written, rows packed. */
  tables?: Record<string, { packs: number; rows: number }>;
  /** The tables whose packing failed, with the error (tried again the next day). */
  failed?: Record<string, string>;
}

export class AutoPack {
  /** The day (in the database's time zone) the job last ran. */
  private lastDay: string | null = null;
  private running: Promise<AutoPackRun> | null = null;

  constructor(
    private readonly app: App,
    private readonly settings: () => DatanotesSettings,
    private readonly run: Runner = (app, settings, input, opts) => packRows(app, settings, input, opts),
  ) {}

  /** Look once: pack the closed periods of every packed table, if the day's packing is due and the engine is quiet. */
  tick(now: Date = new Date()): Promise<AutoPackRun> {
    this.running ??= this.once(now).finally(() => (this.running = null));
    return this.running;
  }

  private async once(now: Date): Promise<AutoPackRun> {
    const s = this.settings();
    if (!s.autoPack || !this.app.packs) return { ran: false };
    const tz = (await readDatabaseConfig(this.app, s)).timezone;
    const day = wallClock(now, tz).slice(0, 10);
    if (this.lastDay === day) return { ran: false };
    const lock = logLockActivity(this.app);
    if (lock.busy || engineWriting(this.app) || now.getTime() - lock.lastEnd < AUTO_PACK.quietMs) return { ran: false };
    const model = cachedMetastore(this.app, s);
    const tables: Record<string, { packs: number; rows: number }> = {};
    const failed: Record<string, string> = {};
    for (const { ref, entry } of model ? catalogTables(model) : []) {
      if (typeof entry.options?.pack !== "string") continue;
      try {
        const r = await this.run(this.app, s, { table: ref.full }, { now });
        if (!r.ok) throw new Error(r.conflicts.map((c) => `${c.path}: ${c.message}`).join("; ") || r.failed.map((f) => `${f.path}: ${f.error}`).join("; ") || "refused");
        const rows = r.packs.reduce((n, p) => n + p.rows.length, 0);
        if (rows > 0) {
          tables[ref.full] = { packs: r.packs.length, rows };
          telemetry().log("INFO", "datanotes packed the closed periods of a table", { table: ref.full, packs: r.packs.length, rows, left_out: r.excluded?.length ?? 0 });
        }
      } catch (e) {
        failed[ref.full] = messageOf(e);
        telemetry().log("WARN", "datanotes could not pack a table: its rows stay as they are until tomorrow", { table: ref.full, error: messageOf(e) });
      }
    }
    this.lastDay = day;
    return { ran: true, tables, ...(Object.keys(failed).length > 0 ? { failed } : {}) };
  }
}
