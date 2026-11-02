/**
 * Opening a path or a link in the database browser (src/ui/lib/open.ts): the table of a row and the
 * target of a link, both from graph_neighbors (faked here with the test vault's answer).
 */

import { describe, expect, it, vi } from "vitest";
import type { ApiAnswer } from "../src/ui/lib/api";
import { resolveLink, tableOfPath } from "../src/ui/lib/open";

const TASK = "datanotes/work/planning/task/Build the button component.md";
const GRAPH = {
  nodes: [
    {
      path: TASK,
      table: "work.planning.task",
      edges: [
        { path: "datanotes/work/planning/project/Design system.md", label: "project" },
        { path: "datanotes/work/planning/person/Edith Clarke.md", label: "assignee" },
        { path: "Meetings/Kickoff.md", label: "link" },
      ],
    },
  ],
};

function op(answer: ApiAnswer) {
  return vi.fn(async (_name: string, _args?: Record<string, unknown>) => answer);
}

const ok = (json: unknown): ApiAnswer => ({ status: 200, ok: true, json: json as Record<string, unknown> });

describe("open", () => {
  it("finds the table of a row", async () => {
    const o = op(ok(GRAPH));
    expect(await tableOfPath(o, TASK)).toBe("work.planning.task");
    expect(o).toHaveBeenCalledWith("graph_neighbors", { from_nodes: { paths: [TASK] }, direction: "out" });
  });

  it("answers null for a plain note, no node, or a refusal", async () => {
    expect(await tableOfPath(op(ok({ nodes: [{ path: "Welcome.md", edges: [] }] })), "Welcome.md")).toBeNull();
    expect(await tableOfPath(op(ok({ nodes: [] })), "x")).toBeNull();
    expect(await tableOfPath(op(ok({})), "x")).toBeNull();
    expect(await tableOfPath(op({ status: 403, ok: false, json: { error: "no" } }), "x")).toBeNull();
  });

  it("resolves a link by exact path, path without .md, or name", async () => {
    const o = op(ok(GRAPH));
    expect(await resolveLink(o, TASK, "Meetings/Kickoff.md")).toBe("Meetings/Kickoff.md");
    expect(await resolveLink(o, TASK, "[[datanotes/work/planning/project/Design system|DS]]")).toBe(
      "datanotes/work/planning/project/Design system.md",
    );
    expect(await resolveLink(o, TASK, "[[edith clarke]]")).toBe("datanotes/work/planning/person/Edith Clarke.md");
    expect(await resolveLink(o, TASK, "[[Nobody]]")).toBeNull();
    expect(await resolveLink(op(ok({ nodes: [{ path: "x" }] })), "x", "[[A]]")).toBeNull();
    expect(await resolveLink(op({ status: 500, ok: false, json: {} }), "x", "[[A]]")).toBeNull();
  });
});
