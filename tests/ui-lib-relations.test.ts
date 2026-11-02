/**
 * The links between tables as the database browser shows them (src/ui/lib/relations.ts).
 */

import { describe, expect, it } from "vitest";
import { incoming, outgoing } from "../src/ui/lib/relations";

const PROJECT = "work.planning.project";
const projectCols = [
  { name: "name", type: "string" },
  { name: "parent", type: "link", ref: "self", hierarchy: true, ref_by: { column: "kind" }, ref_where: null },
  { name: "members", type: "list", items: "link", ref: "work.planning.person", inverse: "projects" },
  { name: "tags", type: "list", items: "string" },
];

describe("outgoing", () => {
  it("lists links and lists of links, self read as the table", () => {
    expect(outgoing(PROJECT, projectCols)).toEqual([
      { table: PROJECT, column: "parent", ref: PROJECT, list: false, hierarchy: true, ref_by: { column: "kind" } },
      { table: PROJECT, column: "members", ref: "work.planning.person", list: true, inverse: "projects" },
    ]);
  });
  it("a link to any note, a ref_where, a column without a name", () => {
    expect(outgoing("t", [{ name: "see", type: "link", ref_where: { a: 1 }, hierarchy: false }, { type: "link" }])).toEqual([
      { table: "t", column: "see", ref: "", list: false, ref_where: { a: 1 } },
    ]);
  });
});

describe("incoming", () => {
  const described = [
    { qualified: "work.planning.task", columns: [{ name: "project", type: "link", ref: PROJECT }, { name: "see", type: "link" }] },
    { qualified: "work.planning.person", columns: [{ name: "projects", type: "list", items: "link", ref: "project" }] },
    { qualified: PROJECT, columns: projectCols },
    { qualified: "other.x.y", columns: [{ name: "z", type: "link", ref: "x.project" }] },
  ];
  it("finds every link to the target, a short ref and self links included", () => {
    expect(incoming(PROJECT, described).map((r) => `${r.table}.${r.column}`)).toEqual([
      "work.planning.task.project",
      "work.planning.person.projects",
      "work.planning.project.parent",
    ]);
  });
  it("nothing links to a table nobody names", () => {
    expect(incoming("work.planning.task", described)).toEqual([]);
  });
});
