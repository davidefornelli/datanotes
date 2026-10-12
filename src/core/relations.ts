/**
 * Inverse link columns, the writes (inverse.ts plans them): sync_relations mirrors links changed
 * by hand onto the linked rows, align_relations adds the reciprocal links that are missing.
 */

import type { App } from "./host";
import { emptyChangeSet } from "./changeset";
import { loadMetastore } from "./metastore";
import { finish, loadRows, loadTable, OperationInputError, type OpResult, type RunOptions } from "./engine";
import type { DatanotesSettings } from "./settings";
import { traced } from "./telemetry";
import { inverseSpecs, inverseTargets, planInverse, type RowChange } from "./inverse";
import { linkedCheckViolations } from "./changeset-checks";

// --- inverse link columns ---

/** Mirror link changes (made by hand) onto the inverse columns of the linked rows. `null`: nothing to do. */
export async function syncRelations(app: App, settings: DatanotesSettings, changes: RowChange[], opts: RunOptions = {}): Promise<OpResult | null> {
  const ms = await loadMetastore(app, settings);
  if (!ms || changes.length === 0) return null;
  const plan = await planInverse(app, settings, ms.model, changes);
  if (plan.edits.size === 0) return null;
  const cs = emptyChangeSet("sync_relations", `mirror links of ${changes.map((c) => c.path).join(", ")}`.slice(0, 200));
  cs.skipInverse = true;
  for (const [path, w] of plan.edits) cs.edits.push({ path, before: w.before, after: w.after });
  // the mirrored links are checked like other writes (CHECKs that follow links, ref_where / ref_by)
  return finish(app, settings, cs, plan.conflicts, await linkedCheckViolations(app, settings, cs, new Set(cs.edits.map((e) => e.path))), opts);
}

export interface AlignRelationsInput {
  table: string;
  /** Only these rows (default: all). */
  paths?: string[];
}

/**
 * Add the reciprocal links that are missing for a table's inverse columns (e.g. after declaring
 * `inverse` on existing data). Single-value links that already point elsewhere are conflicts.
 */
async function alignRelationsImpl(app: App, settings: DatanotesSettings, input: AlignRelationsInput, opts: RunOptions = {}): Promise<OpResult> {
  const t = await loadTable(app, settings, input.table);
  const specs = inverseSpecs(t.catalog.model).get(t.catalog.ref.full);
  if (!specs || specs.length === 0) throw new OperationInputError(`${t.catalog.ref.full} has no inverse link columns`);
  const only = input.paths ? new Set(input.paths.map((p) => (p.endsWith(".md") ? p : `${p}.md`))) : null;
  const rows = (await loadRows(app, settings, t)).filter((r) => !only || only.has(r.file.path));
  const changes: RowChange[] = rows.map((r) => ({
    path: r.file.path,
    table: t.catalog.ref.full,
    before: new Map(),
    after: inverseTargets(app, specs, r.ordered, r.file.path),
  }));
  const plan = await planInverse(app, settings, t.catalog.model, changes, { keepSingles: true });
  const cs = emptyChangeSet("align_relations", `align inverse links of ${t.catalog.ref.full}`, t.def.schemaPath);
  cs.skipInverse = true;
  for (const [path, w] of plan.edits) cs.edits.push({ path, before: w.before, after: w.after });
  // the mirrored links are checked like other writes (CHECKs that follow links, ref_where / ref_by)
  return finish(app, settings, cs, plan.conflicts, await linkedCheckViolations(app, settings, cs, new Set(cs.edits.map((e) => e.path))), opts);
}

export function alignRelations(app: App, settings: DatanotesSettings, input: AlignRelationsInput, opts: RunOptions = {}): Promise<OpResult> {
  return traced(
    "datanotes align_relations",
    { "datanotes.op": "align_relations", table: input.table, dry_run: opts.dryRun === true },
    () => alignRelationsImpl(app, settings, input, opts),
    (r) => ({ severity: r.ok ? "INFO" : "WARN", attributes: { ok: r.ok, notes_changed: r.notes_changed, conflicts: r.conflicts.length } }),
  );
}
