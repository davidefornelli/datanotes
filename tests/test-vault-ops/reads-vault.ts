/**
 * Reads on the test vault beyond the tables: notes and folders, plain-text search, the link graph,
 * link targets, schema inference and semantic search (on a local embedding provider).
 */

import { expect } from "vitest";
import { embeddingStub } from "../helpers/test-vault";
import { MEETINGS, person, project, task, type Scenario } from "./harness";

export const scenarios: Scenario[] = [
  {
    name: "notes: read with their front matter, list folders, plain-text search",
    ops: ["read_note", "list_folder", "search_notes"],
    async run(t) {
      expect((await t.ok<{ content: string }>("read_note", { path: "Welcome.md" })).content).toContain("# Test vault");
      const note = await t.ok<Record<string, any>>("read_note", { path: project("Website relaunch") });
      expect(note.front_matter).toMatchObject({ table: "work.planning.project", name: "Website relaunch", kind: "project", members: ["[[Ada Lovelace]]", "[[Edith Clarke]]"] });
      expect(note.content).toContain("## Risks");
      expect(note.path).toBe(project("Website relaunch"));
      expect(note.size).toBeGreaterThan(0);
      expect(await t.refused("read_note", { path: "Nope.md" })).toBe("no file Nope.md in the vault");
      expect(await t.refused("read_note", { path: "Meetings/" })).toBe("path must name a file, not a folder");
      expect(await t.refused("read_note", { path: "Meetings" })).toBe("Meetings is a folder: list_folder lists it");

      expect(await t.ok("list_folder", { folder: "" })).toEqual({ folder: "", folders: ["Meetings", "datanotes"], files: ["Welcome.md"] });
      expect((await t.ok<{ folders: string[] }>("list_folder", { folder: "datanotes/work/planning" })).folders).toEqual(["datanotes/work/planning/person", "datanotes/work/planning/project", "datanotes/work/planning/task"]);
      expect((await t.ok<{ files: string[] }>("list_folder", { folder: "Meetings" })).files).toEqual(MEETINGS);
      expect(await t.refused("list_folder", { folder: "Nope" })).toBe("no folder Nope in the vault");

      type Hits = { query: string; total: number; results: { path: string; score: number; matches: { context: string }[] }[] };
      const hits = await t.ok<Hits>("search_notes", { query: "colour palette" });
      expect(hits.results.map((h) => h.path)).toEqual([task("Choose the colour palette"), MEETINGS[0]]);
      expect(hits.total).toBe(2);
      expect(hits.results[0]!.score).toBeGreaterThan(hits.results[1]!.score); // the words are in its path too
      expect(hits.results[1]!.matches[0]!.context).toContain("new colour palette");
      // case- and accent-insensitive, every word must occur
      expect((await t.ok<Hits>("search_notes", { query: "RISKS relaunch" })).results.map((h) => h.path)).toEqual([project("Website relaunch")]);
      expect(await t.ok("search_notes", { query: "palette nowhere" })).toEqual({ query: "palette nowhere", results: [], total: 0 });
    },
  },
  {
    name: "the link graph: neighbours, walks and shortest paths",
    ops: ["graph_neighbors", "graph_traverse", "graph_path"],
    async run(t) {
      const n = await t.ok<{ nodes: { path: string; counts: Record<string, number>; edges: { path: string; label: string; direction: string }[] }[] }>("graph_neighbors", {
        from_nodes: { table: "project", where: { name: "Website relaunch" } },
      });
      expect(n.nodes).toHaveLength(1);
      const edges = n.nodes[0]!.edges.map((e) => `${e.direction} ${e.label} ${e.path}`).sort();
      expect(edges).toEqual(
        [
          `in link ${MEETINGS[0]}`,
          `in link ${MEETINGS[2]}`,
          "in link Welcome.md",
          `in parent ${project("Content migration")}`,
          `in parent ${project("Design system")}`,
          `in project ${task("Write the launch post")}`,
          `in projects ${person("Ada Lovelace")}`,
          `in projects ${person("Edith Clarke")}`,
          `out members ${person("Ada Lovelace")}`,
          `out members ${person("Edith Clarke")}`,
          `out parent ${project("Engineering")}`,
        ].sort(),
      );
      expect(n.nodes[0]!.counts).toMatchObject({ "out:parent": 1, "out:members": 2, "in:parent": 2, "in:project": 1 });
      const outOnly = await t.ok<{ nodes: { edges: unknown[] }[] }>("graph_neighbors", { from_nodes: { paths: [task("Pick a query engine")] }, direction: "out" });
      expect(outOnly.nodes[0]!.edges).toHaveLength(2); // project, assignee

      // Edith's work: the tasks assigned to her and the projects she is on, then what they belong to
      const walk = await t.ok<{ start: string[]; nodes: { path: string; depth: number; via: { label: string }[] }[] }>("graph_traverse", {
        from_nodes: { table: "person", where: { name: "Edith Clarke" } },
        direction: "in",
        edges: ["assignee"],
        max_depth: 1,
      });
      expect(walk.start).toEqual([person("Edith Clarke")]);
      expect(walk.nodes.map((x) => x.path).sort()).toEqual([task("Build the button component"), task("Choose the colour palette")]);
      expect(walk.nodes.every((x) => x.depth === 1 && x.via[0]!.label === "assignee")).toBe(true);
      const up = await t.ok<{ nodes: { path: string; depth: number }[] }>("graph_traverse", {
        from_nodes: { paths: [task("Export the old pages")] },
        edges: ["project", "parent"],
        tables: ["project"],
        max_depth: 4,
      });
      expect(up.nodes.map((x) => [x.path, x.depth])).toEqual([
        [project("Content migration"), 1],
        [project("Website relaunch"), 2],
        [project("Engineering"), 3],
      ]);

      const p = await t.ok<{ found: boolean; length: number; via: { from: string; label: string; direction: string; to: string }[] }>("graph_path", {
        from_nodes: { table: "person", where: { name: "Ada Lovelace" } },
        to_nodes: { table: "project", where: { name: "Engineering" } },
      });
      expect(p.found).toBe(true);
      expect(p.length).toBe(2);
      expect(p.via.at(-1)).toMatchObject({ label: "parent", direction: "out", to: project("Engineering") });
      const none = await t.ok("graph_path", { from_nodes: { paths: [task("Export the old pages")] }, to_nodes: { paths: ["Welcome.md"] }, edges: ["assignee"] });
      expect(none).toEqual({ found: false, length: null, via: [] });
    },
  },
  {
    name: "link_options: the rows a link may point to, by the level ref_by gives the row",
    ops: ["list_link_targets"],
    async run(t) {
      type Options = { rows: { name: string; link: string; path: string; kind?: string }[]; total: number; required: boolean; empty: boolean; reason?: string };
      const forNew = await t.ok<Options>("list_link_targets", { table: "project", column: "parent", values: { kind: "workstream" } });
      expect(forNew).toMatchObject({ required: true, empty: false, total: 3, reason: 'kind "workstream" needs kind project' });
      expect(forNew.rows.map((r) => r.name)).toEqual(["Data platform", "Office move", "Website relaunch"]);
      expect(forNew.rows[0]).toEqual({ name: "Data platform", link: "[[datanotes/work/planning/project/Data platform|Data platform]]", path: project("Data platform"), kind: "project" });
      // an existing row: its own level, never itself
      const forRow = await t.ok<Options>("list_link_targets", { table: "project", column: "parent", row: "Website relaunch" });
      expect(forRow.rows.map((r) => r.name)).toEqual(["Engineering", "Operations"]);
      // an area is a top level: the link stays empty
      const forArea = await t.ok<Options>("list_link_targets", { table: "project", column: "parent", values: { kind: "area" } });
      expect(forArea).toMatchObject({ rows: [], empty: true, required: false });
      // no filter: any project, by name
      const any = await t.ok<Options>("list_link_targets", { table: "task", column: "project", limit: 2 });
      expect(any.total).toBe(8);
      expect(any.rows).toHaveLength(2);
      expect(await t.refused("list_link_targets", { table: "task", column: "title" })).toBe('"title" is not a link column with ref in work.planning.task');
    },
  },
  {
    name: "infer_table: a table proposed from plain notes, and the keys a table's rows use without declaring them",
    ops: ["infer_table"],
    async run(t) {
      const inf = await t.ok<Record<string, any>>("infer_table", { folder: "Meetings", name: "meeting" });
      expect(inf.files).toBe(4);
      expect(inf.paths).toEqual(MEETINGS);
      const cols = Object.fromEntries(inf.columns.map((c: Record<string, unknown>) => [c.name, c]));
      expect(cols.date).toMatchObject({ type: "date", required: true });
      expect(cols.kind).toMatchObject({ type: "enum", values: ["kickoff", "review"], required: true });
      expect(cols.project).toMatchObject({ type: "link", ref: "work.planning.project" });
      expect(cols.attendees).toMatchObject({ type: "list", items: "link", ref: "work.planning.person" });
      expect(cols.mood).toMatchObject({ type: "string" });
      expect(cols.mood.required).toBeFalsy();
      expect(inf.proposal).toMatchObject({ name: "meeting" });
      expect(inf.adopt).toEqual({ paths: MEETINGS, relocate: false });
      const declared = await t.ok<Record<string, any>>("infer_table", { table: "task" });
      expect(declared).toMatchObject({ files: 8, columns: [], hints: ["every front matter key the rows use is declared"] });
    },
  },
  {
    name: "infer_table's proposal goes to create_table once its descriptions are written",
    ops: ["infer_table", "create_table"],
    async run(t) {
      const inf = await t.ok<{ proposal: { columns: Record<string, unknown>[] } & Record<string, unknown> }>("infer_table", { folder: "Meetings", name: "meeting" });
      expect(inf.proposal).toMatchObject({ name: "meeting", description: null, time_column: "date" });
      expect(inf.proposal).not.toHaveProperty("filename");
      // the notes cannot say what the table and its columns mean: as it is, the proposal is refused
      expect(await t.refused("create_table", inf.proposal)).toBe("descriptions are required: work.planning.meeting has none for the table and columns attendees, date, kind, project, mood");
      const meaning: Record<string, string> = {
        attendees: "The people at the meeting",
        date: "The day of the meeting",
        kind: "What kind of meeting it was",
        project: "The project the meeting was about",
        mood: "How the meeting went, in a word",
      };
      const columns = inf.proposal.columns.map((c) => ({ ...c, description: meaning[String(c.name)] }));
      await t.ok("create_table", { ...inf.proposal, description: "Meetings about the projects", columns });
      expect(await t.ok<Record<string, any>>("describe_table", { table: "meeting" })).toMatchObject({ qualified: "work.planning.meeting", row_count: 0, description: "Meetings about the projects" });
    },
  },
  {
    name: 'infer_table with folder "" reads the whole vault',
    ops: ["infer_table"],
    async run(t) {
      const inf = await t.ok<{ paths: string[]; skipped: { path: string; reason: string }[]; proposal: { name: string } }>("infer_table", { folder: "" });
      expect(inf.paths).toEqual([...MEETINGS, "Welcome.md"]);
      expect(inf.skipped).toContainEqual({ path: task("Find the new office"), reason: "already a row of work.planning.task" });
      expect(inf.proposal.name).toBe("notes");
    },
  },
  {
    name: "semantic search, refused while it is off",
    ops: ["semantic_search", "describe_semantic_index", "sync_semantic_index"],
    async run(t) {
      expect(await t.refused("semantic_search", { query: "colour palette" })).toContain("semantic search is off");
      expect(await t.ok("describe_semantic_index", {})).toMatchObject({ enabled: false, files: 0 });
      expect(await t.refused("sync_semantic_index", { rebuild: "yes" })).toBe('sync_semantic_index: "rebuild" must be a boolean, not string "yes"');
    },
  },
  {
    name: "semantic search on a local embedding provider: index, search with filters, rebuild",
    ops: ["semantic_search", "describe_semantic_index", "sync_semantic_index"],
    open: async () => {
      const stub = await embeddingStub();
      return { options: { settings: stub.settings }, close: stub.close };
    },
    async run(t) {
      expect(await t.ok("describe_semantic_index", {})).toMatchObject({ enabled: true, provider: "ollama", model: "stub-embed" });
      await t.ok("sync_semantic_index", {});
      const status = await t.ok<{ files: number; passages: number; pending: number }>("describe_semantic_index", {});
      expect(status.files).toBe(25); // 20 rows, 4 meetings, Welcome.md
      expect(status.passages).toBeGreaterThanOrEqual(25);
      type Hits = { query: string; results: { path: string; score: number; table?: string }[] };
      const tasks = await t.ok<Hits>("semantic_search", { query: "colour palette", tables: ["task"], limit: 3 });
      expect(tasks.results[0]).toMatchObject({ path: task("Choose the colour palette"), table: "work.planning.task" });
      expect(tasks.results.length).toBeLessThanOrEqual(3);
      expect(tasks.results.every((r) => r.table === "work.planning.task")).toBe(true);
      const meetings = await t.ok<Hits>("semantic_search", { query: "colour palette", folder: "Meetings" });
      expect(meetings.results[0]!.path).toBe(MEETINGS[0]);
      expect(meetings.results.every((r) => r.path.startsWith("Meetings/"))).toBe(true);
      const strict = await t.ok<Hits>("semantic_search", { query: "colour palette", min_score: 0.99 });
      expect(strict.results).toEqual([]);
      await t.ok("sync_semantic_index", { rebuild: true });
      expect(await t.ok("describe_semantic_index", {})).toMatchObject({ files: 25 });
    },
  },
];
