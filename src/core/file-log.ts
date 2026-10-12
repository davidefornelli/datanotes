/**
 * Log files in the engine's store: `store:logs/<YYYY-MM-DD>.<source>.jsonl`
 * (`<source>`: the process writing, e.g. `service`), one record per
 * line (see {@link FileLogger}). Files older than the retention are deleted by {@link pruneLogs}.
 */

import type { App } from "./host";
import type { DatanotesSettings } from "./settings";
import { storeAppend, storeList, storePath, storeRemove } from "./store";

type Settings = Pick<DatanotesSettings, "logRetentionDays">;

/** `<day>.<source>.jsonl`, or `<day>.jsonl` without a source. */
export function logFilePath(_settings: object, day: string, source?: string): string {
  return storePath("logs", source ? `${day}.${source}.jsonl` : `${day}.jsonl`);
}

export async function appendLog(app: App, settings: object, day: string, lines: string, source?: string): Promise<void> {
  await storeAppend(app, logFilePath(settings, day, source), lines);
}

/** Delete log files older than the retention; returns the deleted paths. */
export async function pruneLogs(app: App, settings: Settings, now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - settings.logRetentionDays * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const f of (await storeList(app, storePath("logs"))).files) {
    const day = /(\d{4}-\d{2}-\d{2})(?:\.[a-z0-9-]+)?\.jsonl$/.exec(f)?.[1];
    if (day && day < cutoff) {
      await storeRemove(app, f);
      removed.push(f);
    }
  }
  return removed;
}
