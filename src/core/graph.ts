/**
 * Graph traversal over the vault's links.
 *
 * Nodes are notes (labelled with the table they are a row of, when any). Edges come from:
 * - link columns of tables (`people`, `event`, …): labelled with the column name, read from the
 *   row's frontmatter (so rows the plugin just wrote are visible at once);
 * - every other resolved link Obsidian knows (`metadataCache.resolvedLinks`): label `link`.
 *
 * The index is built on demand and reused until the vault (file-cache generation) or the loaded
 * metastore changes. On a host that keeps backlinks (the headless host) with a vault index, it is
 * kept up to date instead (see {@link TypedGraph}): a write recomputes the edges of the rows it
 * changed, and of the rows whose links look up the name of a file that came or went.
 */

import type { App, TFile } from "./host";
import { loadRows, loadTable, OperationInputError, type LoadedTable } from "./engine";
import { readFrontmatterEntries, vaultGeneration } from "./file-cache";
import { fmGet } from "./frontmatter";
import { fileLookupNames, linkLookupNames } from "./link-names";
import { sortedRowFiles } from "./row-files";
import type { TableDefinition } from "./types-table";
import type { OrderedFrontmatter } from "./types";
import { vaultIndex, type VaultIndex } from "./vault-index";
import { cachedMetastore, loadMetastore, metastorePath, type Metastore } from "./metastore";
import { compileWhere, resolveWithin, type Where } from "./rows";
import type { DatanotesSettings } from "./settings";
import { listTables } from "./table-registry";
import { parseWikilink } from "./validate";
import { guide, unknownName } from "./hints";
import { count, phase } from "./tracing";

export const LINK_LABEL = "link";
export const MAX_GRAPH_DEPTH = 10;
export const MAX_GRAPH_NODES = 5000;

export interface Edge {
  to: string;
  label: string;
}

/** A node's edges: undefined for a node without any. */
export type GraphEdges = Pick<ReadonlyMap<string, Edge[]>, "get" | "has" | "keys">;

export interface GraphIndex {
  /** The edges from a note, in the order a build adds them. */
  out: GraphEdges;
  /** The edges to a note (`to` is the note linking to it), in the order a build adds them. */
  in: GraphEdges;
  /** Table (qualified name) of each row. */
  tableOf: ReadonlyMap<string, string>;
}

const GRAPHS = new WeakMap<object, { generation: number; metastore: Metastore | null; graph: GraphIndex }>();
/** The build under way, by app: the calls that need the same graph meanwhile wait for it. */
const BUILDS = new WeakMap<object, { generation: number; metastore: Metastore | null; graph: Promise<GraphIndex> }>();
/** The vault generation and metastore path at which the metastore last failed to parse, per app. */
const UNPARSABLE = new WeakMap<object, string>();

function linkTargets(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(parseWikilink).filter((l): l is string => l != null);
}

/** The edges already added, `from\0to\0label` (a hub note has thousands: no scan of its list). */
type EdgeKeys = Set<string>;

/** The graph a full build makes: plain maps. */
interface BuiltGraph {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
  tableOf: Map<string, string>;
}

function addEdge(g: BuiltGraph, keys: EdgeKeys, from: string, to: string, label: string): void {
  const key = `${from}\0${to}\0${label}`;
  if (keys.has(key)) return;
  keys.add(key);
  const out = g.out.get(from);
  if (out) out.push({ to, label });
  else g.out.set(from, [{ to, label }]);
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
  // kept up to date where the host keeps backlinks (else, or when a row cannot be read, built)
  const kept = await keptGraph(app, settings, metastore, generation);
  if (kept) return kept;
  const cached = GRAPHS.get(app);
  if (cached && cached.generation === generation && cached.metastore === metastore) {
    count("datanotes.graph.cache_hits");
    return cached.graph;
  }
  // Calls at the same time (an app reading every table's links at once) share one build.
  const building = BUILDS.get(app);
  if (building && building.generation === generation && building.metastore === metastore) {
    count("datanotes.graph.build_waits");
    return building.graph;
  }
  const graph = buildGraph(app, settings, generation, metastore);
  BUILDS.set(app, { generation, metastore, graph });
  try {
    return await graph;
  } finally {
    if (BUILDS.get(app)?.graph === graph) BUILDS.delete(app);
  }
}

function buildGraph(app: App, settings: DatanotesSettings, generation: number, metastore: Metastore | null): Promise<GraphIndex> {
  return fullGraph(app, settings).then((g) => {
    GRAPHS.set(app, { generation, metastore, graph: g });
    return g;
  });
}

/** The link graph built from every table's rows and every resolved link. */
function fullGraph(app: App, settings: DatanotesSettings): Promise<BuiltGraph> {
  // a rebuild reads every table's rows: a span, it can be most of a graph call's time
  return phase("engine.graph.build", async (span) => {
    const g: BuiltGraph = { out: new Map(), in: new Map(), tableOf: new Map() };
    const typed = new Set<string>(); // "from\0to" pairs already covered by a labelled edge
    const keys: EdgeKeys = new Set();
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
            addEdge(g, keys, r.file.path, dest.path, c.name);
            typed.add(`${r.file.path}\0${dest.path}`);
          }
        }
      }
    }
    const resolved = app.metadataCache.resolvedLinks;
    for (const [from, dests] of Object.entries(resolved)) {
      for (const to of Object.keys(dests)) {
        if (to === from || typed.has(`${from}\0${to}`)) continue;
        addEdge(g, keys, from, to, LINK_LABEL);
      }
    }
    span.setAttributes({ "datanotes.graph.nodes": g.tableOf.size, "datanotes.graph.sources": g.out.size });
    return g;
  });
}

// --- The graph kept up to date ---

/** A table whose rows are nodes: its place in the order of the tables, and its link columns. */
interface GraphTable {
  index: number;
  def: TableDefinition;
  linkColumns: string[];
}

/**
 * The typed edges (link columns) of every row, kept from one graph call to the next from the vault
 * index's logs; the `link` edges are read from the host's resolved links and backlinks when asked.
 * A node's edges are those a full build gives, in its order: from a row, its typed edges (by column,
 * then value) then its other links (in the order the host resolved them); to a note, the typed
 * edges (by table, then row path) then the other links (by the host's order of the notes, which is
 * the order of its resolved links).
 */
interface TypedGraph {
  epoch: number;
  cursor: number;
  fileCursor: number;
  model: Metastore | null;
  settings: string;
  tables: Map<string, GraphTable>;
  /** Each row of a table with link columns: its table. */
  rowTable: Map<string, string>;
  /** A row's typed edges, in order; and the notes they lead to. */
  edges: Map<string, Edge[]>;
  targets: Map<string, Set<string>>;
  /** A note → the rows with a typed edge to it. */
  into: Map<string, Set<string>>;
  /** The names a row's typed links look up, and the rows looking up each name. */
  names: Map<string, readonly string[]>;
  lookers: Map<string, Set<string>>;
  /** The graph as read from these edges, while nothing changed (a new one after any vault event: the file cache's generation). */
  view?: { generation: number; graph: GraphIndex };
}

const TYPED = new WeakMap<object, TypedGraph>();
/** The update under way, by app: one at a time. */
const KEEPING = new WeakMap<object, Promise<unknown>>();

interface Backlinked {
  backlinksOf?(path: string): Record<string, number>;
}

/** The graph kept up to date, or null where it cannot be (no vault index or backlinks, a row that cannot be read). */
async function keptGraph(app: App, settings: DatanotesSettings, metastore: Metastore | null, generation = vaultGeneration(app)): Promise<GraphIndex | null> {
  const backlinks = (app.metadataCache as unknown as Backlinked).backlinksOf;
  if (typeof backlinks !== "function") return null;
  const idx = vaultIndex(app, settings);
  if (!idx || idx.hasFailures) return null;
  const run = (KEEPING.get(app) ?? Promise.resolve()).then(
    () => keepTyped(app, settings, idx, metastore),
    () => keepTyped(app, settings, idx, metastore),
  );
  KEEPING.set(app, run);
  const g = await run;
  if (!g) return null;
  if (g.view?.generation !== generation) g.view = { generation, graph: graphView(app, idx, g, backlinks.bind(app.metadataCache)) };
  return g.view.graph;
}

/** The tables of the graph, in the order of a build (listTables), with their definitions. */
async function graphTables(app: App, settings: DatanotesSettings): Promise<Map<string, GraphTable>> {
  const out = new Map<string, GraphTable>();
  for (const ref of listTables(app, settings.databaseFolder)) {
    let t: LoadedTable;
    try {
      t = await loadTable(app, settings, ref.qualified);
    } catch {
      continue; // an ambiguous or broken table does not break the graph
    }
    const linkColumns = t.def.columns.filter((c) => c.type === "link" || (c.type === "list" && c.items === "link")).map((c) => c.name);
    out.set(ref.qualified, { index: out.size, def: t.def, linkColumns });
  }
  return out;
}

async function keepTyped(app: App, settings: DatanotesSettings, idx: VaultIndex, model: Metastore | null): Promise<TypedGraph | null> {
  const key = JSON.stringify([settings.databaseFolder, settings.tableKey]);
  let g = TYPED.get(app);
  const notes = g && g.model === model && g.settings === key && g.epoch === idx.epoch ? idx.changedSince(g.cursor, idx.epoch) : null;
  const files = g && notes ? idx.filesChangedSince(g.fileCursor, idx.epoch) : null;
  const cursor = idx.cursor;
  const fileCursor = idx.fileCursor;
  const keep = new Set([settings.tableKey]);
  /** A row's typed edges and the names its links look up; false when it cannot be read. */
  const addRow = async (t: TypedGraph, path: string, table: string): Promise<boolean> => {
    const f = app.vault.getAbstractFileByPath(path)!; // a row of the index is a file of the vault
    let ordered: OrderedFrontmatter;
    try {
      ordered = await readFrontmatterEntries(app, f as TFile, keep);
    } catch {
      return false;
    }
    t.rowTable.set(path, table);
    const edges: Edge[] = [];
    const targets = new Set<string>();
    const seen = new Set<string>();
    const names = new Set<string>();
    for (const c of t.tables.get(table)!.linkColumns) {
      for (const linkpath of linkTargets(fmGet(ordered, c))) {
        for (const n of linkLookupNames(linkpath, path)) names.add(n);
        const dest = app.metadataCache.getFirstLinkpathDest(linkpath, path);
        if (!dest || dest.path === path) continue;
        targets.add(dest.path);
        if (seen.has(`${dest.path}\0${c}`)) continue;
        seen.add(`${dest.path}\0${c}`);
        edges.push({ to: dest.path, label: c });
      }
    }
    if (edges.length > 0) {
      t.edges.set(path, edges);
      t.targets.set(path, targets);
      for (const to of targets) {
        let from = t.into.get(to);
        if (!from) t.into.set(to, (from = new Set()));
        from.add(path);
      }
    }
    if (names.size > 0) {
      const list = [...names];
      t.names.set(path, list);
      for (const n of list) {
        let who = t.lookers.get(n);
        if (!who) t.lookers.set(n, (who = new Set()));
        who.add(path);
      }
    }
    return true;
  };
  const dropRow = (t: TypedGraph, path: string) => {
    t.rowTable.delete(path);
    for (const to of t.targets.get(path) ?? []) {
      const from = t.into.get(to)!; // registered with the edge
      from.delete(path);
      if (from.size === 0) t.into.delete(to);
    }
    t.edges.delete(path);
    t.targets.delete(path);
    for (const n of t.names.get(path) ?? []) {
      const who = t.lookers.get(n)!; // registered with the name
      who.delete(path);
      if (who.size === 0) t.lookers.delete(n);
    }
    t.names.delete(path);
  };
  /** Whether `path` is a row of a table of the graph now (its archive and exclude folders left out). */
  const tableOfRow = (t: TypedGraph, path: string): string | null => {
    const table = idx.note(path)?.table ?? null;
    const gt = table === null ? undefined : t.tables.get(table);
    if (!gt) return null;
    return [...(gt.def.options.exclude ?? []), gt.def.layout.archive].some((dir) => path.startsWith(`${dir}/`)) ? null : table;
  };
  if (g && notes && files && notes.size === 0 && files.size === 0) return g; // nothing changed
  if (!g || !notes || !files) {
    TYPED.delete(app);
    const t: TypedGraph = { epoch: idx.epoch, cursor, fileCursor, model, settings: key, tables: await graphTables(app, settings), rowTable: new Map(), edges: new Map(), targets: new Map(), into: new Map(), names: new Map(), lookers: new Map() };
    for (const [full, gt] of t.tables) {
      for (const f of sortedRowFiles(app, settings, full, gt.def)) if (!(await addRow(t, f.path, full))) return null;
    }
    TYPED.set(app, t);
    return t;
  }
  // the rows changed, and those whose links look up the name of a file that came or went
  const dirty = new Set(notes);
  for (const p of files) for (const n of fileLookupNames(p)) for (const s of g.lookers.get(n) ?? []) dirty.add(s);
  for (const path of dirty) {
    dropRow(g, path);
    const table = tableOfRow(g, path);
    if (table !== null && !(await addRow(g, path, table))) {
      TYPED.delete(app);
      return null;
    }
  }
  g.cursor = cursor;
  g.fileCursor = fileCursor;
  g.view = undefined;
  return g;
}

/** The graph as a build gives it, read from the kept typed edges and the host's links. */
function graphView(app: App, idx: VaultIndex, g: TypedGraph, backlinksOf: (path: string) => Record<string, number>): GraphIndex {
  const resolved = app.metadataCache.resolvedLinks;
  const typedTo = (from: string, to: string) => g.targets.get(from)?.has(to) === true;
  const outOf = (node: string): Edge[] | undefined => {
    const out = [...(g.edges.get(node) ?? [])];
    for (const to of Object.keys(resolved[node] ?? {})) if (to !== node && !typedTo(node, to)) out.push({ to, label: LINK_LABEL });
    return out.length > 0 ? out : undefined;
  };
  /** The notes with edges from them, in the order a build adds their first edge: the rows (by table, then path), then the other notes. */
  function* sources(): IterableIterator<string> {
    const rows = [...g.edges.keys()].sort((a, b) => g.tables.get(g.rowTable.get(a)!)!.index - g.tables.get(g.rowTable.get(b)!)!.index || a.localeCompare(b));
    yield* rows;
    for (const from of Object.keys(resolved)) if (!g.edges.has(from) && outOf(from)) yield from;
  }
  /** The notes with edges to them, in the order a build adds their first edge. */
  function* targets(): IterableIterator<string> {
    const seen = new Set<string>();
    for (const from of sources()) {
      for (const e of outOf(from)!) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        yield e.to;
      }
    }
  }
  return {
    tableOf: g.rowTable,
    out: {
      get: outOf,
      has: (node: string) => outOf(node) !== undefined,
      keys: sources,
    },
    in: {
      has(node: string): boolean {
        return this.get(node) !== undefined;
      },
      keys: targets,
      get(node: string): Edge[] | undefined {
        const out: Edge[] = [];
        // typed edges: by the table's place, then the row's path, then the row's own order
        const typed = [...(g.into.get(node) ?? [])].sort((a, b) => g.tables.get(g.rowTable.get(a)!)!.index - g.tables.get(g.rowTable.get(b)!)!.index || a.localeCompare(b));
        for (const from of typed) for (const e of g.edges.get(from)!) if (e.to === node) out.push({ to: from, label: e.label });
        // other links: in the host's order of the notes (that of its resolved links)
        const order = (p: string) => idx.note(p)?.order ?? Number.MAX_SAFE_INTEGER;
        const links = Object.keys(backlinksOf(node)).filter((from) => from !== node && !typedTo(from, node)).sort((a, b) => order(a) - order(b));
        for (const from of links) out.push({ to: from, label: LINK_LABEL });
        return out.length > 0 ? out : undefined;
      },
    },
  };
}

/**
 * How the graph kept up to date differs from a full build now (index-check.ts): every node's
 * edges, in order, and every row's table. Empty when they agree, or when none is kept.
 */
export async function verifyGraph(app: App, settings: DatanotesSettings): Promise<string[]> {
  if (!TYPED.has(app)) return [];
  const kept = await keptGraph(app, settings, cachedMetastore(app, settings));
  if (!kept) return [];
  const full = await fullGraph(app, settings);
  const out: string[] = [];
  const nodes = new Set([...full.out.keys(), ...full.in.keys(), ...full.tableOf.keys(), ...kept.tableOf.keys()]);
  const show = (g: GraphIndex, n: string) => JSON.stringify([g.out.get(n) ?? null, g.in.get(n) ?? null, g.tableOf.get(n) ?? null]);
  for (const n of nodes) if (show(kept, n) !== show(full, n)) out.push(`graph: the edges or the table of ${n} differ`);
  return out;
}

// --- Start sets ---

export interface GraphNodeSet {
  /** Vault paths (with or without `.md`). */
  paths?: string[];
  /** Rows of a table, optionally filtered with a `where` (as in select_rows). */
  table?: string;
  where?: Where;
  /**
   * The rows of several tables: table names, or patterns as a token's write permission has them:
   * `*` (every table), `catalog.*`, `catalog.schema.*`. The whole vault's graph in one call.
   */
  tables?: string[];
}

const NODE_SET_HINT = guide(`Pass {"paths": [...]}, {"table": ..., "where": {...}} or {"tables": [...]}: ["*"] is every table, ["personal.*"] every table of a catalog.`, "graphTables");

/** A pattern of `tables`: `*`, `catalog.*`, `catalog.schema.*`. */
const TABLE_PATTERN = /^(\*|[\w-]+(\.[\w-]+)?\.\*)$/;

/** The tables (full names) a `tables` list names, in the database's order. */
function tablesOf(app: App, settings: DatanotesSettings, names: unknown, what: string): string[] {
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    throw new OperationInputError(`${what}: "tables" must be a list of table names or patterns`, NODE_SET_HINT);
  }
  const all = listTables(app, settings.databaseFolder);
  const out = new Set<string>();
  for (const n of names as string[]) {
    if (TABLE_PATTERN.test(n)) {
      const prefix = n.slice(0, -1); // "" for "*"
      for (const t of all) if (t.qualified.startsWith(prefix)) out.add(t.qualified);
      continue;
    }
    if (n.includes("*")) throw new OperationInputError(`${what}: "${n}" is not a table pattern`, NODE_SET_HINT);
    for (const full of qualifiedTables(app, settings, [n], `${what}.tables`)!) out.add(full);
  }
  return all.map((t) => t.qualified).filter((q) => out.has(q));
}

async function resolveNodes(app: App, settings: DatanotesSettings, set: GraphNodeSet, what: string): Promise<string[]> {
  if (!set || typeof set !== "object") throw new OperationInputError(`"${what}" must be an object with "paths", "table" or "tables"`, NODE_SET_HINT);
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
    throw new OperationInputError(`${what}: "where" needs "table"`, NODE_SET_HINT);
  }
  if (set.tables !== undefined) {
    for (const full of tablesOf(app, settings, set.tables, what)) {
      for (const r of await loadRows(app, settings, await loadTable(app, settings, full))) out.add(r.file.path);
    }
  }
  if (!set.paths && set.table === undefined && set.tables === undefined) throw new OperationInputError(`"${what}" needs "paths", "table" or "tables"`, NODE_SET_HINT);
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
