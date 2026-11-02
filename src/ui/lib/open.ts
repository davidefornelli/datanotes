// Opening a path or a link: which table a note is a row of, and which note a link points at, both
// answered by the engine's link graph (graph_neighbors), so the browser never resolves names itself.
// Pure: the operation call is injected.

import type { ApiAnswer } from "./api";
import { basename, linkTarget } from "./format";

type OpCall = (name: string, args?: Record<string, unknown>) => Promise<ApiAnswer>;

interface GraphNode {
  path: string;
  table?: string;
  edges?: { path: string }[];
}

async function nodeOf(op: OpCall, path: string): Promise<GraphNode | null> {
  const a = await op("graph_neighbors", { from_nodes: { paths: [path] }, direction: "out" });
  if (a.status !== 200) return null;
  return ((a.json as { nodes?: GraphNode[] }).nodes ?? [])[0] ?? null;
}

/** The qualified table of the row at `path`; null for a plain note, an unknown path or a refusal. */
export async function tableOfPath(op: OpCall, path: string): Promise<string | null> {
  return (await nodeOf(op, path))?.table ?? null;
}

/** The path a link in the note at `fromPath` points at ("[[Name]]", "Name" or "a/b.md"); null when none. */
export async function resolveLink(op: OpCall, fromPath: string, text: string): Promise<string | null> {
  const target = linkTarget(text) ?? text;
  const edges = (await nodeOf(op, fromPath))?.edges ?? [];
  const name = basename(target).toLowerCase();
  const hit =
    edges.find((e) => e.path === target) ??
    edges.find((e) => e.path === `${target}.md`) ??
    edges.find((e) => basename(e.path).toLowerCase() === name);
  return hit?.path ?? null;
}
