import { describe, expect, it } from "vitest";
import { linkReaders, linkTargetOf, mapWhere, modelColumns, readersBlocking, readsColumn, rewrittenEntries } from "../src/core/link-paths";
import { parseMetastore, refOf } from "../src/core/metastore";

/**
 * A work planning catalog: projects inherit an owner and a parent (`ref: self`) from bases; tasks
 * link to a project, to reviewers and to other tasks, with CHECKs and filtered links that read
 * through those links. `personal.contacts.person` makes the short name `person` ambiguous.
 */
const TEXT = `config:
  default_catalog: work
bases:
  owned:
    description: Rows with an owner
    columns:
      - { name: owner, type: link, ref: work.planning.person }
  nested:
    columns:
      - { name: parent, type: link, ref: self, hierarchy: true }
catalogs:
  personal:
    schemas:
      contacts:
        tables:
          person:
            columns:
              - { name: name, type: string, required: true }
  work:
    schemas:
      planning:
        tables:
          person:
            columns:
              - { name: name, type: string, required: true }
              - { name: team, type: enum, values: [data, platform] }
          project:
            bases: [owned, nested]
            columns:
              - { name: title, type: string, required: true }
              - { name: status, type: enum, values: [active, paused, archived] }
          task:
            columns:
              - { name: title, type: string }
              - { name: notes, type: string }
              - { name: level, type: enum, values: [epic, story, subtask] }
              - { name: project, type: link, ref: work.planning.project, ref_where: { status: active } }
              - { name: reviewers, type: list, items: link, ref: work.planning.person, ref_where: { team: data } }
              - { name: parent, type: link, ref: self, ref_by: { column: level, levels: [epic, story, subtask] } }
              - { name: blocked_by, type: list, items: link, ref: self }
            constraints:
              open_project: { not: { project.status: archived } }
              data_or_paused: { or: [{ project.owner.team: data }, { project.status: paused }] }
              pending:
`;

const MODEL = parseMetastore(TEXT);
const TASK = "work.planning.task";
const PROJECT = "work.planning.project";
const PERSON = "work.planning.person";

describe("modelColumns", () => {
  it("gives a table's columns with the inherited ones first and ref: self resolved", () => {
    expect(modelColumns(MODEL, PROJECT)).toEqual([
      { name: "owner", type: "link", ref: PERSON },
      { name: "parent", type: "link", ref: PROJECT, hierarchy: true },
      { name: "title", type: "string", required: true },
      { name: "status", type: "enum", values: ["active", "paused", "archived"] },
    ]);
  });

  it("reads a short name that matches tables of two catalogs as no table", () => {
    expect(modelColumns(MODEL, "person")).toBeNull();
    expect(modelColumns(MODEL, "contacts.person")).toEqual([{ name: "name", type: "string", required: true }]);
    expect(modelColumns(MODEL, "work.planning.meeting")).toBeNull();
  });

  it("falls back to the table's own columns, self resolved, when it redefines an inherited column", () => {
    const m = parseMetastore(`bases:
  owned:
    columns:
      - { name: owner, type: link, ref: work.planning.person }
catalogs:
  work:
    schemas:
      planning:
        tables:
          person:
            columns: [{ name: name, type: string }]
          milestone:
            bases: [owned]
            columns:
              - { name: owner, type: link, ref: work.planning.team }
              - { name: next, type: link, ref: self }
`);
    expect(modelColumns(m, "work.planning.milestone")).toEqual([
      { name: "owner", type: "link", ref: "work.planning.team" },
      { name: "next", type: "link", ref: "work.planning.milestone" },
    ]);
  });
});

describe("linkTargetOf", () => {
  it("is the ref of a link or a list of links, the owner for ref: self", () => {
    expect(linkTargetOf({ name: "project", type: "link", ref: PROJECT }, TASK)).toBe(PROJECT);
    expect(linkTargetOf({ name: "reviewers", type: "list", items: "link", ref: PERSON }, TASK)).toBe(PERSON);
    expect(linkTargetOf({ name: "blocked_by", type: "list", items: "link", ref: "self" }, TASK)).toBe(TASK);
  });

  it("is null for a column that links nowhere", () => {
    expect(linkTargetOf(undefined, TASK)).toBeNull();
    expect(linkTargetOf({ name: "related", type: "link" }, TASK)).toBeNull();
    expect(linkTargetOf({ name: "related", type: "link", ref: null }, TASK)).toBeNull();
    expect(linkTargetOf({ name: "labels", type: "list", items: "string", ref: PERSON }, TASK)).toBeNull();
    expect(linkTargetOf({ name: "owner_name", type: "string", ref: PERSON }, TASK)).toBeNull();
  });
});

describe("mapWhere", () => {
  const status = (t: string, c: string) => (t === PROJECT && c === "status" ? "state" : c);

  it("rewrites a key read through a link inside a single not", () => {
    expect(mapWhere(MODEL, TASK, { not: { "project.status": "archived" } }, { key: status })).toEqual({ not: { "project.state": "archived" } });
  });

  it("rewrites every filter of an or list, through two links", () => {
    const hops: string[] = [];
    const out = mapWhere(MODEL, TASK, { or: [{ "project.owner.team": "data" }, { "project.status": "paused" }] }, {
      key: (t, c) => (t === PERSON && c === "team" ? "squad" : status(t, c)),
      hop: (t, c, target) => hops.push(`${t}.${c} -> ${target}`),
    });
    expect(out).toEqual({ or: [{ "project.owner.squad": "data" }, { "project.state": "paused" }] });
    expect(hops).toEqual([`${TASK}.project -> ${PROJECT}`, `${PROJECT}.owner -> ${PERSON}`, `${TASK}.project -> ${PROJECT}`]);
  });

  it("keeps a path condition as it is: path is not a column", () => {
    const seen: string[] = [];
    const out = mapWhere(MODEL, TASK, { path: { contains: "Archive/" }, "project.status": "active" }, {
      key: (t, c) => {
        seen.push(`${t}.${c}`);
        return status(t, c);
      },
      cond: (_t, _c, cond) => ({ in: [cond] }),
    });
    expect(out).toEqual({ path: { contains: "Archive/" }, "project.state": { in: ["active"] } });
    expect(seen).toEqual([`${TASK}.project`, `${PROJECT}.status`]);
  });

  it("stops at a key part that is not a link: the parts after it are read on no table", () => {
    const seen: string[] = [];
    const cond = (t: string, c: string, v: unknown) => {
      seen.push(`cond ${t}.${c}`);
      return v;
    };
    const out = mapWhere(MODEL, TASK, { "notes.status.text": "active", title: "Launch" }, {
      key: (t, c) => {
        seen.push(`${t}.${c}`);
        return c.toUpperCase();
      },
      cond,
    });
    expect(out).toEqual({ "NOTES.status.text": "active", TITLE: "Launch" });
    expect(seen).toEqual([`${TASK}.notes`, `${TASK}.title`, `cond ${TASK}.title`]);
    expect(readsColumn(MODEL, TASK, { "notes.status": "active" }, PROJECT, "status")).toBe(false);
    expect(readsColumn(MODEL, TASK, { "project.status": "active" }, PROJECT, "status")).toBe(true);
  });

  it("returns a filter that is not a mapping unchanged", () => {
    expect(mapWhere(MODEL, TASK, null, { key: status })).toBeNull();
    expect(mapWhere(MODEL, TASK, [{ "project.status": "active" }], { key: status })).toEqual([{ "project.status": "active" }]);
  });
});

describe("linkReaders / readersBlocking", () => {
  it("lists the CHECKs and filtered link columns that read through links, with the tables they read", () => {
    expect(linkReaders(MODEL)).toEqual([
      { owner: TASK, what: "CHECK open_project", reads: new Set([PROJECT]) },
      { owner: TASK, what: "CHECK data_or_paused", reads: new Set([PROJECT, PERSON]) },
      { owner: TASK, what: "project (ref_where / ref_by)", reads: new Set([PROJECT]) },
      { owner: TASK, what: "reviewers (ref_where / ref_by)", reads: new Set([PERSON]) },
      { owner: TASK, what: "parent (ref_where / ref_by)", reads: new Set([TASK]) },
    ]);
  });

  it("names every reader of a table that is renamed or dropped, but not the table's own", () => {
    expect(readersBlocking(MODEL, PERSON, "drop")).toEqual([
      { message: `CHECK data_or_paused of ${TASK} reads ${PERSON} through a link: drop or change it before you drop the table (link targets are not rewritten)` },
      { message: `reviewers (ref_where / ref_by) of ${TASK} reads ${PERSON} through a link: drop or change it before you drop the table (link targets are not rewritten)` },
    ]);
    expect(readersBlocking(MODEL, PROJECT, "rename").map((r) => r.message)).toEqual([
      `CHECK open_project of ${TASK} reads ${PROJECT} through a link: drop or change it before you rename the table (link targets are not rewritten)`,
      `CHECK data_or_paused of ${TASK} reads ${PROJECT} through a link: drop or change it before you rename the table (link targets are not rewritten)`,
      `project (ref_where / ref_by) of ${TASK} reads ${PROJECT} through a link: drop or change it before you rename the table (link targets are not rewritten)`,
    ]);
    expect(readersBlocking(MODEL, TASK, "drop")).toEqual([]);
  });

  it("skips a CHECK left empty and a filter on a column that links nowhere", () => {
    const m = parseMetastore(`catalogs:
  work:
    schemas:
      planning:
        tables:
          note:
            columns:
              - { name: title, type: string }
              - { name: related, type: link, ref_where: { status: active } }
              - { name: topic, type: string, ref_by: { column: title, levels: [area, topic] } }
            constraints:
              titled: { title: { exists: true } }
              draft:
`);
    expect(linkReaders(m)).toEqual([]);
  });
});

describe("rewrittenEntries", () => {
  // rename_value story -> feature in task.level: the metastore being written has the new value,
  // and the ref_by levels of task.parent still name the old one.
  const after = parseMetastore(TEXT.replace("values: [epic, story, subtask]", "values: [epic, feature, subtask]"));
  const word = (v: string) => (v === "story" ? "feature" : v);

  it("returns the entries whose ref_by the rewrite changes, with the new ref_by", () => {
    const calls: string[] = [];
    const out = rewrittenEntries(MODEL, after, {
      refBy: (owner, target, by) => {
        calls.push(`${owner} -> ${target}`);
        return owner === TASK && target === TASK ? { ...by, levels: (by.levels as string[]).map(word) } : by;
      },
    });
    const task = after.catalogs.work!.schemas.planning!.tables.task!;
    expect(calls).toEqual([`${TASK} -> ${TASK}`]);
    expect(out).toEqual([
      {
        ref: refOf("work", "planning", "task"),
        entry: {
          ...task,
          columns: task.columns.map((c) => (c.name === "parent" ? { ...c, ref_by: { column: "level", levels: ["epic", "feature", "subtask"] } } : c)),
        },
      },
    ]);
  });

  it("returns nothing when the rewrite leaves every filter as it was", () => {
    expect(rewrittenEntries(MODEL, after, { refBy: (_o, _t, by) => ({ ...by }) })).toEqual([]);
  });
});
