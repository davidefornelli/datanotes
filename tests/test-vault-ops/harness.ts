/**
 * Scenarios on the committed test vault (`test-vault/`): each runs on a new copy, on every host it
 * names (`service`: `datanotes serve` on the Node host; `in-process`: the route handlers on the
 * vault of the in-memory tests), through the same `call(op, args)`.
 *
 * A scenario names the operations it covers (`ops`): after it runs, each of them must have been
 * called, and `check_table` must find no violation (the vault is left valid). `coverage.test.ts`
 * checks that the scenarios together cover every operation of the API.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../../src/core/engine";
import { HOSTS, openTestVault, until, type HostKind, type OpenOptions, type TestVault } from "../helpers/test-vault";

// An unknown table is retried while the host's index may lag (Obsidian): 8 × 150 ms per refusal.
// Both hosts here index the engine's writes at once, as in the other engine tests.
INDEX_RETRY.delayMs = 1;

export interface Scenario {
  name: string;
  /** Operations this scenario covers: each must be called when it runs. */
  ops: string[];
  /** Hosts it runs on (default: both). */
  hosts?: HostKind[];
  /** Engine settings for the copy (e.g. semantic search on a stub provider). */
  open?: () => Promise<{ options: OpenOptions; close(): Promise<void> }>;
  /**
   * A known engine bug: the scenario asserts the correct behaviour and is registered with
   * `it.fails` (it passes while the bug is there; fix the engine, then drop `bug`). Its `ops` do not
   * count for the coverage.
   */
  bug?: string;
  timeout?: number;
  run(t: TestVault): Promise<void>;
}

/** `TEST_VAULT_BUGS=1`: run the known-bug scenarios as plain tests, to see how they fail. */
const SHOW_BUGS = process.env.TEST_VAULT_BUGS === "1";

export function runScenarios(scenarios: Scenario[]): void {
  for (const host of HOSTS) {
    describe(host, () => {
      for (const s of scenarios) {
        if (s.hosts && !s.hosts.includes(host)) continue;
        const test = s.bug && !SHOW_BUGS ? it.fails : it;
        test(
          s.bug ? `${s.name} (BUG: ${s.bug})` : s.name,
          async () => {
            const extra = await s.open?.();
            const t = await openTestVault(host, extra?.options ?? {});
            try {
              await s.run(t);
              const missing = s.ops.filter((op) => !t.used.has(op));
              expect(missing, `operations the scenario names but did not call: ${missing.join(", ")}`).toEqual([]);
              const check = await t.ok<{ violations: unknown[] }>("check_table", {});
              expect(check.violations, "the scenario left rows that break the schema").toEqual([]);
            } finally {
              await t.stop();
              await extra?.close();
            }
          },
          s.timeout ?? 20_000,
        );
      }
    });
  }
}

// --- the test vault's tables and rows ---

export const METASTORE = "datanotes/metastore.yaml";
export const TABLE_DIR = { person: "datanotes/work/planning/person", project: "datanotes/work/planning/project", task: "datanotes/work/planning/task" };
export const person = (name: string) => `${TABLE_DIR.person}/${name}.md`;
export const project = (name: string) => `${TABLE_DIR.project}/${name}.md`;
export const task = (title: string) => `${TABLE_DIR.task}/${title}.md`;
export const MEETINGS = [
  "Meetings/2026-09-02 Website kickoff.md",
  "Meetings/2026-09-09 Data platform kickoff.md",
  "Meetings/2026-09-23 Website review.md",
  "Meetings/2026-09-30 Data platform review.md",
];

export interface WriteResult {
  ok: boolean;
  migration_id: string;
  notes_changed: number;
  files_created: number;
  files_moved: number;
  files_deleted: number;
  planned_edits: { path: string; set: Record<string, unknown>; remove: string[] }[];
  planned_creates: string[];
  planned_moves: { from: string; to: string }[];
  planned_deletes: string[];
  planned_texts: string[];
  conflicts: { path: string; message: string }[];
  violations: unknown[];
  dry_run: boolean;
}

export interface Rows<R = Record<string, any>> {
  table: string;
  total: number;
  rows: (R & { path: string })[];
  view?: string;
}

/** The rows of a select, by one column. */
export const pluck = (r: Rows, col: string) => r.rows.map((x) => x[col]);

/** Undo the migrations, newest first, and check the vault is back to `before`, byte for byte. */
export async function undoBackTo(t: TestVault, before: Record<string, string>, ...ids: string[]): Promise<void> {
  for (const id of [...ids].reverse()) await t.ok("undo_migration", { migration_id: id });
  expectFiles(t, before);
}

/** The notes and the metastore are exactly `before`. */
export function expectFiles(t: TestVault, before: Record<string, string>): void {
  const now = t.files();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((k) => before[k] !== now[k]);
  expect(changed, `files that differ from the state before: ${changed.join(", ")}`).toEqual([]);
}

/** An event of the change feed (list_changes, webhooks). */
/** A change feed event as list_changes answers it. */
export interface FeedEvent {
  seq: number;
  table: string | null;
  /** The kind of change: insert, update, delete, move, metastore, tool_call, unreadable. */
  kind: string;
  /** The operation that made it (absent for hand edits). */
  op?: string;
  path: string;
  old_path?: string;
  row_id?: string;
  source: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  actor?: Record<string, unknown>;
  migration_id?: string;
  cause?: { path: string; old_path: string; seq?: number }[];
  violations?: { path: string; violations: { code: string; column?: string; index?: number; constraint?: string; message: string }[] }[];
}
export type FeedPage = { events: FeedEvent[]; last: number; head: number };

/** An event's violations, one per line with its row's path (the event groups them by row). */
export const flatViolations = (vs: FeedEvent["violations"]) => (vs ?? []).flatMap((r) => r.violations.map((v) => ({ path: r.path, ...v })));

/** The newest sequence number of the change feed. */
export const head = async (t: TestVault) => (await t.ok<FeedPage>("list_changes", { limit: 1 })).head;

/** The next event about `path` after `since` (hand edits are compared in batches, a moment later). */
export async function nextEventAbout(t: TestVault, since: number, path: string): Promise<FeedEvent> {
  return until(async () => (await t.ok<FeedPage>("list_changes", { since, wait_ms: 2000 })).events.find((e) => e.path === path), 10_000, `an event about ${path}`);
}
