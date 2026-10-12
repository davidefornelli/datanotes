/**
 * Graph traversal over the vault's links.
 *
 * Nodes are notes (labelled with the table they are a row of, when any). Edges come from:
 * - link columns of tables (`people`, `event`, …): labelled with the column name, read from the
 *   row's frontmatter (so rows the plugin just wrote are visible at once);
 * - every other resolved link Obsidian knows (`metadataCache.resolvedLinks`): label `link`.
 *
 * The index is built on demand and reused until the vault (file-cache generation) or the loaded
 * metastore changes.
 */

import type { App } from "./host";
import { loadRows, loadTable, OperationInputError, type LoadedTable } from "./engine";
import { vaultGeneration } from "./file-cache";
import { fmGet } from "./frontmatter";
import { cachedMetastore, loadMetastore, metastorePath, type Metastore } from "./metastore";
import { compileWhere, resolveWithin, type Where } from "./rows";
import type { DatanotesSettings } from "./settings";
import { listTables } from "./table-registry";
import { parseWikilink } from "./validate";
import { guide, unknownName } from "./hints";

export const LINK_LABEL = "link";
export const MAX_GRAPH_DEPTH = 10;
export const MAX_GRAPH_NODES = 5000;

export interface Edge {
  to: string;
  label: string;
}

export interface GraphIndex {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
  /** Table (qualified name) of each row. */
  tableOf: Map<string, string>;
}

const GRAPHS = new WeakMap<object, { generation: number; metastore: Metastore | null; graph: GraphIndex }>();
/** The vault generation and metastore path at which the metastore last failed to parse, per app. */
const UNPARSABLE = new WeakMap<object, string>();

function linkTargets(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(parseWikilink).filter((l): l is string => l != null);
}

function addEdge(g: GraphIndex, from: string, to: string, label: string): void {
  const out = g.out.get(from) ?? [];
  if (out.some((e) => e.to === to && e.label === label)) return;
  out.push({ to, label });
  g.out.set(from, out);
  const back = g.in.get(to) ?? [];
  back.push({ to: from, label });
  g.in.set(to, back);
}

/** The link graph, rebuilt only when the vault changed since the last build. */
export async function graphIndex(app: App, settings: DatanotesSettings): Promise<GraphIndex> {
  const generation = vaultGeneration(app);
  // The tables come from the metastore cache: load it when nothing has yet (a graph built without
  // it has no tables), and build again when another metastore is loaded.
  let metastore = cachedMetastore(app, settings);
  const attempt = `${generation}\0${metastorePath(settings)}`;
  if (!metastore && UNPARSABLE.get(app) !== attempt) {
    try {
      metastore = (await loadMetastore(app, settings))?.model ?? null;
    } catch {
      // a broken metastore: no tables, as listTables sees it; not read again until the vault changes
      UNPARSABLE.set(app, attempt);
    }
  }
  const cached = GRAPHS.get(app);
  if (cached && cached.generation === generation && cached.metastore === metastore) return cached.graph;
  const g: GraphIndex = { out: new Map(), in: new Map(), tableOf: new Map() };
  const typed = new Set<string>(); // "from\0to" pairs already covered by a labelled edge
  for (const ref of listTables(app, settings.databaseFolder)) {
    let t: LoadedTable;
    try {
      t = await loadTable(app, settings, ref.qualified);
    } catch {
      continue; // an ambiguous or broken table does not break the graph
    }
    const linkColumns = t.def.columns.filter((c) => c.type === "link" || (c.type === "list" && c.items === "link"));
    for (const r of await loadRows(app, settings, t)) {
      g.tableOf.set(r.file.path, ref.qualified);
      for (const c of linkColumns) {
        for (const linkpath of linkTargets(fmGet(r.ordered, c.name))) {
          const dest = app.metadataCache.getFirstLinkpathDest(linkpath, r.file.path);
          if (!dest || dest.path === r.file.path) continue;
          addEdge(g, r.file.path, dest.path, c.name);
          typed.add(`${r.file.path}\0${dest.path}`);
        }
      }
    }
  }
  const resolved = app.metadataCache.resolvedLinks;
  for (const [from, dests] of Object.entries(resolved)) {
    for (const to of Object.keys(dests)) {
      if (to === from || typed.has(`${from}\0${to}`)) continue;
      addEdge(g, from, to, LINK_LABEL);
    }
  }
  GRAPHS.set(app, { generation, metastore, graph: g });
  return g;
}

// --- Start sets ---

export interface GraphNodeSet {
  /** Vault paths (with or without `.md`). */
  paths?: string[];
  /** Rows of a table, optionally filtered with a `where` (as in select_rows). */
  table?: string;
  where?: Where;
}

async function resolveNodes(app: App, settings: DatanotesSettings, set: GraphNodeSet, what: string): Promise<string[]> {
  if (!set || typeof set !== "object") throw new OperationInputError(`"${what}" must be an object with "paths" or "table"`);
  const out = new Set<string>();
  for (const p of set.paths ?? []) {
    const path = p.endsWith(".md") ? p : `${p}.md`;
    if (app.vault.getAbstractFileByPath(path) == null) throw new OperationInputError(`${what}: note not found: ${path}`);
    out.add(path);
  }
  if (set.table !== undefined) {
    const t = await loadTable(app, settings, set.table);
    const pred = compileWhere(await resolveWithin(app, settings, t, set.where), t, settings);
    for (const r of await loadRows(app, settings, t)) if (pred(r)) out.add(r.file.path);
  } else if (set.where !== undefined) {
    throw new OperationInputError(`${what}: "where" needs "table"`);
  }
  if (!set.paths && set.table === undefined) throw new OperationInputError(`"${what}" needs "paths" or "table"`);
  return [...out].sort();
}

// --- Operations ---

export type Direction = "out" | "in" | "both";

function stepsFrom(g: GraphIndex, node: string, direction: Direction, labels: Set<string> | null): { to: string; label: string; dir: "out" | "in" }[] {
  const steps: { to: string; label: string; dir: "out" | "in" }[] = [];
  if (direction !== "in") for (const e of g.out.get(node) ?? []) if (!labels || labels.has(e.label)) steps.push({ ...e, dir: "out" });
  if (direction !== "out") for (const e of g.in.get(node) ?? []) if (!labels || labels.has(e.label)) steps.push({ ...e, dir: "in" });
  return steps;
}

function checkDirection(d: unknown): Direction {
  if (d === undefined) return "both";
  if (d !== "out" && d !== "in" && d !== "both") throw new OperationInputError(`"direction" must be "out", "in" or "both"`);
  return d;
}

function labelSet(edges: string[] | undefined): Set<string> | null {
  return edges && edges.length > 0 ? new Set(edges) : null;
}

export interface NeighborsInput {
  from: GraphNodeSet;
  direction?: Direction;
  /** Edge labels to follow (column names, or `link` for other links); default all. */
  edges?: string[];
}

export interface NeighborEdge {
  path: string;
  table?: string;
  label: string;
  /** `out`: this note links to it; `in`: it links to this note. */
  direction: "out" | "in";
}

/** Direct neighbours of each start note, with edge labels and counts per label. */
export async function graphNeighbors(app: App, settings: DatanotesSettings, input: NeighborsInput) {
  const direction = checkDirection(input.direction);
  const g = await graphIndex(app, settings);
  const labels = labelSet(input.edges);
  const nodes = await resolveNodes(app, settings, input.from, "from");
  if (nodes.length > MAX_GRAPH_NODES) throw new OperationInputError(`"from" matches ${nodes.length} notes (max ${MAX_GRAPH_NODES}): narrow it`);
  return {
    nodes: nodes.map((path) => {
      const edges: NeighborEdge[] = stepsFrom(g, path, direction, labels).map((s) => ({
        path: s.to,
        ...(g.tableOf.has(s.to) ? { table: g.tableOf.get(s.to)! } : {}),
        label: s.label,
        direction: s.dir,
      }));
      const counts: Record<string, number> = {};
      for (const e of edges) counts[`${e.direction}:${e.label}`] = (counts[`${e.direction}:${e.label}`] ?? 0) + 1;
      return { path, ...(g.tableOf.has(path) ? { table: g.tableOf.get(path)! } : {}), counts, edges };
    }),
  };
}

export interface TraverseInput {
  from: GraphNodeSet;
  direction?: Direction;
  edges?: string[];
  /** Return only nodes of these tables (the walk still passes through any note). */
  tables?: string[];
  /** Only walk through notes of these tables (plus the start notes). */
  through?: string[];
  minDepth?: number;
  maxDepth?: number;
  limit?: number;
}

export interface Step {
  from: string;
  label: string;
  direction: "out" | "in";
  to: string;
}

export interface TraversedNode {
  path: string;
  table?: string;
  depth: number;
  /** One shortest route from a start note. */
  via: Step[];
}

function qualifiedTables(app: App, settings: DatanotesSettings, names: string[] | undefined, what: string): Set<string> | null {
  if (!names || names.length === 0) return null;
  const all = listTables(app, settings.databaseFolder);
  const out = new Set<string>();
  for (const n of names) {
    const hits = all.filter((t) => t.qualified === n || t.qualified.endsWith(`.${n}`));
    if (hits.length === 0) {
      throw new OperationInputError(`${what}: unknown table "${n}"`, unknownName(n.split(".").pop()!, all.map((t) => t.name), "tables", "list_tables lists them.", "graph"));
    }
    if (hits.length > 1) {
      throw new OperationInputError(`${what}: "${n}" matches ${hits.map((h) => h.qualified).join(", ")}`, guide(`Name the table in full: ${hits.map((h) => h.qualified).join(" or ")}.`, "graph"));
    }
    out.add(hits[0]!.qualified);
  }
  return out;
}

/** Breadth-first walk from the start notes; each reached note once, at its shortest depth. */
export async function graphTraverse(app: App, settings: DatanotesSettings, input: TraverseInput) {
  const direction = checkDirection(input.direction ?? "out");
  const minDepth = input.minDepth ?? 1;
  const maxDepth = input.maxDepth ?? 2;
  if (!Number.isInteger(minDepth) || !Number.isInteger(maxDepth) || minDepth < 0 || maxDepth < minDepth || maxDepth > MAX_GRAPH_DEPTH) {
    throw new OperationInputError(`need 0 <= min_depth <= max_depth <= ${MAX_GRAPH_DEPTH}`);
  }
  const limit = Math.min(Math.max(input.limit ?? 500, 1), MAX_GRAPH_NODES);
  const g = await graphIndex(app, settings);
  const labels = labelSet(input.edges);
  const want = qualifiedTables(app, settings, input.tables, "tables");
  const through = qualifiedTables(app, settings, input.through, "through");
  const starts = await resolveNodes(app, settings, input.from, "from");
  const via = new Map<string, Step[]>(starts.map((s) => [s, []]));
  let frontier = starts;
  const found: TraversedNode[] = [];
  let truncated = false;
  const emit = (path: string, depth: number) => {
    if (depth < minDepth) return;
    const table = g.tableOf.get(path);
    if (want && (!table || !want.has(table))) return;
    if (found.length >= limit) {
      truncated = true;
      return;
    }
    found.push({ path, ...(table ? { table } : {}), depth, via: via.get(path)! });
  };
  for (const s of starts) emit(s, 0);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      if (depth > 1 && through && !through.has(g.tableOf.get(node) ?? "")) continue; // do not walk on from here
      for (const s of stepsFrom(g, node, direction, labels)) {
        if (via.has(s.to)) continue;
        via.set(s.to, [...via.get(node)!, { from: node, label: s.label, direction: s.dir, to: s.to }]);
        next.push(s.to);
      }
    }
    next.sort();
    for (const n of next) emit(n, depth);
    frontier = next;
  }
  return { start: starts, nodes: found, truncated };
}

export interface PathInput {
  from: GraphNodeSet;
  to: GraphNodeSet;
  direction?: Direction;
  edges?: string[];
  maxDepth?: number;
}

/** Shortest path (fewest links) from any `from` note to any `to` note, or null. */
export async function graphPath(app: App, settings: DatanotesSettings, input: PathInput) {
  const direction = checkDirection(input.direction);
  const maxDepth = input.maxDepth ?? 6;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_GRAPH_DEPTH) {
    throw new OperationInputError(`need 1 <= max_depth <= ${MAX_GRAPH_DEPTH}`);
  }
  const g = await graphIndex(app, settings);
  const labels = labelSet(input.edges);
  const sources = await resolveNodes(app, settings, input.from, "from");
  const targets = new Set(await resolveNodes(app, settings, input.to, "to"));
  const via = new Map<string, Step[]>(sources.map((s) => [s, []]));
  const hit = sources.find((s) => targets.has(s));
  if (hit) return { found: true, length: 0, via: [], from: hit, to: hit };
  let frontier = sources;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const s of stepsFrom(g, node, direction, labels)) {
        if (via.has(s.to)) continue;
        const steps = [...via.get(node)!, { from: node, label: s.label, direction: s.dir, to: s.to }];
        if (targets.has(s.to)) return { found: true, length: depth, via: steps, from: steps[0]!.from, to: s.to };
        via.set(s.to, steps);
        next.push(s.to);
      }
    }
    frontier = next.sort();
  }
  return { found: false, length: null, via: [] };
}
