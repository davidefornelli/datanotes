/**
 * Engine edges (engine.ts): create_table refusals and file names, link column rules checked on
 * add_column / alter_column (vocabulary, hierarchy, inverse, ref_by), inverse links mirrored inside
 * one operation, listeners and the transaction log failing without failing the write, hand edits
 * counted on the log, and the undo of a batch whose operations were undone one by one.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineBase, setTableBases } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import {
  addColumn,
  alterColumn,
  createTable,
  emptyResult,
  INDEX_RETRY,
  logExternalEdits,
  onApplied,
  OperationInputError,
  opSummary,
  serializeOptions,
  undoOperation,
  withSystemIdColumn,
  type AppliedOperation,
} from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { describeHistory } from "../src/core/history";
import { listMigrations } from "../src/core/journal";
import { parseMetastore } from "../src/core/metastore";
import { createPublicApi } from "../src/core/public-api";
import { insertRow, mergeRows, updateRows } from "../src/core/rows";
import { MalformedColumnError } from "../src/core/table-loader";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createDbVault, logVault, LOG_DIR, METASTORE, type DbVault } from "./helpers/db-vault";
import { described, describedBase } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;
afterEach(() => setTelemetry(NOOP_TELEMETRY));

const fm = (v: DbVault, p: string) => Object.fromEntries(readOrderedFromMarkdown(v.read(p)).ordered);
const entryOf = (v: DbVault, full: string) => {
  const [c, s, t] = full.split(".");
  return parseMetastore(v.read(METASTORE)).catalogs[c!]!.schemas[s!]!.tables[t!]!;
};

/** The promise rejects with exactly this error class and message. */
async function refused(p: Promise<unknown>, cls: abstract new (...args: never[]) => Error, message: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(cls);
  expect((e as Error).message).toBe(message);
}

/** Collect the telemetry log lines. */
function logLines(): { severity: string; body: string; attrs: Record<string, unknown> }[] {
  const logs: { severity: string; body: string; attrs: Record<string, unknown> }[] = [];
  setTelemetry({ log: (severity, body, attrs = {}) => logs.push({ severity, body, attrs }), flush: async () => {} });
  return logs;
}

const P = "Datanotes/main/work/project";
const ref = (n: string) => `[[${n}]]`;

/** `main.work.project` (self-referencing tree) and `main.work.task` linking to it. */
async function workVault(history = false): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", ...(history ? { history: true } : {}) }, async () => {});
  expect(
    (
      await createTable(v.app, v.settings, described({
        schema: "work",
        name: "project",
        options: { filename: "{name}" },
        columns: [
          { name: "name", type: "string", required: true, dense: true },
          { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
          { name: "budget", type: "number", min: 0 },
          { name: "parent", type: "link", ref: "self" },
        ],
      }))
    ).ok,
  ).toBe(true);
  expect(
    (
      await createTable(v.app, v.settings, described({
        schema: "work",
        name: "task",
        options: { filename: "{title}" },
        columns: [
          { name: "title", type: "string", required: true, dense: true },
          { name: "scope", type: "enum", values: ["area", "project", "workstream"] },
          { name: "project", type: "link", ref: "main.work.project" },
        ],
      }))
    ).ok,
  ).toBe(true);
  for (const [name, kind, parent] of [
    ["Home", "area", null],
    ["Site", "project", "Home"],
    ["Shop", "project", "Home"],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(parent ? { parent: ref(parent) } : {}) } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  return v;
}

describe("create_table", () => {
  it("refuses an id column that is not a string: id is the system row id", async () => {
    const v = await workVault();
    const before = v.read(METASTORE);
    await refused(
      createTable(v.app, v.settings, described({
        schema: "work",
        name: "invoice",
        options: { filename: "{number}" },
        columns: [
          { name: "id", type: "integer" },
          { name: "number", type: "string", required: true },
        ],
      })),
      OperationInputError,
      `"id" is reserved for the system row id (a UUID string)`,
    );
    expect(v.read(METASTORE)).toBe(before);
  });

  it("needs a name", async () => {
    const v = await workVault();
    await refused(
      createTable(v.app, v.settings, described({ schema: "work", options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] })),
      OperationInputError,
      `pass "name" (and optionally "catalog", "schema") to create a table`,
    );
  });

  it("names the rows of a date column by the date part of the format, YYYY-MM-DD when the format starts with the time", async () => {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", default_filename: "HHmm" }, async () => {});
    const r = await createTable(v.app, v.settings, described({
      schema: "health",
      name: "weight",
      timeColumn: "day",
      columns: [
        { name: "day", type: "date", required: true, dense: true },
        { name: "kg", type: "number", min: 0 },
      ],
    }));
    expect(r.ok).toBe(true);
    expect(entryOf(v, "main.health.weight").options).toEqual({ filename: "{day:YYYY-MM-DD}", archive: "_archive" });
    // a datetime column keeps the configured format
    expect((await createTable(v.app, v.settings, described({ schema: "health", name: "pulse", timeColumn: "at", columns: [{ name: "at", type: "datetime", required: true }] }))).ok).toBe(true);
    expect(entryOf(v, "main.health.pulse").options).toEqual({ filename: "{at:HHmm}", archive: "_archive" });
    const row = await insertRow(v.app, v.settings, { table: "weight", values: { day: "2026-10-08", kg: 71.5 } });
    expect(row.planned_creates).toEqual(["Datanotes/main/health/weight/2026-10-08.md"]);
  });
});

describe("link column rules on add_column", () => {
  it("refuses a vocabulary that is not a table", async () => {
    const v = await workVault();
    await refused(
      addColumn(v.app, v.settings, described({ table: "task", column: { name: "topic", type: "string", vocabulary: "main.work.topic" } })),
      OperationInputError,
      `main.work.task.topic: vocabulary "main.work.topic" is not a table`,
    );
  });

  it("refuses a hierarchy column that points at another table", async () => {
    const v = await workVault();
    await refused(
      addColumn(v.app, v.settings, described({ table: "task", column: { name: "parent", type: "link", ref: "main.work.project", hierarchy: true } })),
      OperationInputError,
      `main.work.task.parent: a hierarchy column must point at its own table (ref: self)`,
    );
  });

  it("refuses ref_by on a link to a table that does not exist (the ref check names it)", async () => {
    const v = await workVault();
    await refused(
      addColumn(v.app, v.settings, described({
        table: "task",
        column: { name: "client", type: "link", ref: "main.crm.client", ref_by: { column: "scope", levels: ["area", "project", "workstream"] } },
      })),
      OperationInputError,
      `main.work.task.client: ref "main.crm.client" is not a table`,
    );
  });

  it("refuses ref_by whose target column is neither an enum nor a string", async () => {
    const v = await workVault();
    await refused(
      addColumn(v.app, v.settings, described({
        table: "task",
        column: { name: "funded_by", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "budget", levels: ["area", "project", "workstream"] } },
      })),
      OperationInputError,
      `main.work.task.funded_by: ref_by target column main.work.project.budget must be an enum or string column`,
    );
  });

  it("refuses a ref_by map that allows a value the target enum does not have; a valid map is stored", async () => {
    const v = await workVault();
    await refused(
      addColumn(v.app, v.settings, described({
        table: "task",
        column: { name: "under", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "kind", map: { area: null, project: ["area"], workstream: ["programme"] } } },
      })),
      OperationInputError,
      `main.work.task.under: ref_by allows "programme", not a value of main.work.project.kind (area, project, workstream)`,
    );
    const ok = await addColumn(v.app, v.settings, described({
      table: "task",
      column: { name: "under", type: "link", ref: "main.work.project", ref_by: { column: "scope", target_column: "kind", map: { area: null, project: ["area"], workstream: ["project"] } } },
    }));
    expect(ok.ok, JSON.stringify([ok.conflicts, ok.violations])).toBe(true);
    expect(entryOf(v, "main.work.task").columns.at(-1)).toEqual({
      name: "under",
      type: "link",
      ref: "main.work.project",
      ref_by: { column: "scope", target_column: "kind", map: { area: null, project: ["area"], workstream: ["project"] } },
      description: "Test column under",
    });
  });

  it("refuses a column without a name, at the position it would take", async () => {
    const v = await workVault();
    const before = v.read(METASTORE);
    await refused(
      addColumn(v.app, v.settings, described({ table: "task", column: { type: "string" } })),
      MalformedColumnError,
      `columns[4]: "name" must start with a letter and contain only letters, digits, "_" or "-"`,
    );
    expect(v.read(METASTORE)).toBe(before);
  });
});

describe("inverse link columns", () => {
  /** `main.people.person`: `manager` and `reports` link each other (one declared by full name, one as self). */
  async function people(): Promise<DbVault> {
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    const r = await createTable(v.app, v.settings, described({
      schema: "people",
      name: "person",
      options: { filename: "{name}" },
      columns: [
        { name: "name", type: "string", required: true, dense: true },
        { name: "role", type: "string" },
        { name: "manager", type: "link", ref: "main.people.person", inverse: "reports" },
        { name: "reports", type: "list", items: "link", ref: "self", inverse: "manager" },
      ],
    }));
    expect(r.ok, JSON.stringify(r.conflicts)).toBe(true);
    for (const name of ["Ada", "Bob", "Cy", "Dee"]) expect((await insertRow(v.app, v.settings, { table: "person", values: { name } })).ok).toBe(true);
    return v;
  }
  const D = "Datanotes/main/people/person";

  it("a table created with a link to itself by full name may declare the inverse in the same create_table", async () => {
    const v = await people();
    expect(entryOf(v, "main.people.person").columns.slice(3).map((c) => [c.name, c.ref, c.inverse])).toEqual([
      ["manager", "main.people.person", "reports"],
      ["reports", "self", "manager"],
    ]);
    const r = await updateRows(v.app, v.settings, { table: "person", where: { name: "Bob" }, set: { manager: ref("Ada") } });
    expect([r.ok, r.notes_changed, r.planned_edits.map((p) => p.path)]).toEqual([true, 2, [`${D}/Bob.md`, `${D}/Ada.md`]]);
    expect(fm(v, `${D}/Ada.md`).reports).toEqual([ref("Bob")]);
  });

  it("a back-link already in place is not written again: only the edited row changes", async () => {
    const v = await people();
    v.write(`${D}/Ada.md`, v.read(`${D}/Ada.md`).replace("name: Ada\n", `name: Ada\nreports:\n  - "${ref("Cy")}"\n`));
    const r = await updateRows(v.app, v.settings, { table: "person", where: { name: "Cy" }, set: { manager: ref("Ada") } });
    expect([r.ok, r.notes_changed, r.planned_edits.map((p) => p.path)]).toEqual([true, 1, [`${D}/Cy.md`]]);
    expect(fm(v, `${D}/Ada.md`).reports).toEqual([ref("Cy")]);
  });

  it("a back-link on a row the same operation edits is merged into that row's own edit", async () => {
    const v = await people();
    const r = await mergeRows(v.app, v.settings, {
      table: "person",
      on: ["name"],
      rows: [
        { name: "Ada", role: "CTO" },
        { name: "Dee", manager: ref("Ada") },
      ],
    });
    expect([r.ok, r.notes_changed, r.planned_edits]).toEqual([
      true,
      2,
      [
        { path: `${D}/Ada.md`, set: { role: "CTO", reports: [ref("Dee")] }, remove: [] },
        { path: `${D}/Dee.md`, set: { manager: ref("Ada") }, remove: [] },
      ],
    ]);
    expect(fm(v, `${D}/Ada.md`)).toMatchObject({ name: "Ada", role: "CTO", reports: [ref("Dee")] });
  });
});

describe("columns inherited from a base", () => {
  it("alter_column may restyle an inherited column but not change its rules (a metastore refusal, as an input error)", async () => {
    const v = await workVault();
    expect((await defineBase(v.app, v.settings, describedBase({ name: "tracked", columns: [{ name: "priority", type: "integer", min: 1, max: 5 }] }))).ok).toBe(true);
    expect((await setTableBases(v.app, v.settings, { table: "task", bases: ["tracked"] })).ok).toBe(true);
    const before = v.read(METASTORE);
    await refused(
      alterColumn(v.app, v.settings, { table: "task", name: "priority", changes: { max: 3 } }),
      OperationInputError,
      `main.work.task: column "priority" is inherited from base "tracked": change the base (only label, description, aliases, note, dense can differ)`,
    );
    expect(v.read(METASTORE)).toBe(before);
    expect((await alterColumn(v.app, v.settings, { table: "task", name: "priority", changes: { label: "Importance" } })).ok).toBe(true);
    const task = entryOf(v, "main.work.task");
    expect([task.bases, task.columns.map((c) => c.name)]).toEqual([["tracked"], ["id", "priority", "title", "scope", "project"]]);
    expect(task.columns[1]).toEqual({ name: "priority", label: "Importance" });
  });
});

describe("after the write", () => {
  it("a listener that throws is logged and does not stop the operation nor the other listeners", async () => {
    const v = await workVault();
    const logs = logLines();
    const seen: AppliedOperation[] = [];
    const offs = [
      onApplied(v.app, () => {
        throw new Error("listener down");
      }),
      onApplied(v.app, () => {
        throw "quota exceeded";
      }),
      onApplied(v.app, (e) => seen.push(e)),
    ];
    try {
      const r = await insertRow(v.app, v.settings, { table: "task", values: { title: "Paint the fence", project: ref("Site") } });
      expect(r.ok).toBe(true);
      expect(seen.map((e) => [e.op, e.migrationId, e.paths, e.moves, e.deletes])).toEqual([
        ["insert_row", r.migration_id, ["Datanotes/main/work/task/Paint the fence.md"], [], []],
      ]);
      expect(logs.filter((l) => l.body === "datanotes apply listener failed").map((l) => [l.severity, l.attrs])).toEqual([
        ["WARN", { error: "listener down" }],
        ["WARN", { error: "quota exceeded" }],
      ]);
    } finally {
      for (const off of offs) off();
    }
  });

  it("a transaction log that cannot be read is reported and the write still succeeds", async () => {
    const v = await workVault(true);
    // the engine's log folder replaced by a file (a broken copy of the hidden store)
    const store = path.join(v.storeRoot, "transaction_log");
    fs.rmSync(store, { recursive: true });
    fs.writeFileSync(store, "not a folder");
    const logs = logLines();
    const r = await insertRow(v.app, v.settings, { table: "task", values: { title: "Order paint" } });
    expect([r.ok, r.notes_changed, r.files_created, r.commits]).toEqual([true, 0, 1, undefined]);
    expect(v.exists("Datanotes/main/work/task/Order paint.md")).toBe(true);
    const warned = logs.filter((l) => l.body === "datanotes transaction log not updated");
    expect(warned.map((l) => [l.severity, l.attrs.operation])).toEqual([
      ["WARN", "EXTERNAL_EDIT"],
      ["WARN", "WRITE"],
    ]);
    // the error is the file system's: a file where the log folder should be
    for (const w of warned) expect(w.attrs.error).toMatch(/ENOTDIR/);
  });
});

describe("hand edits counted on the transaction log", () => {
  const top = async (v: DbVault) => (await describeHistory(v.app, v.settings, { table: "project", limit: 1 })).history[0]!;

  it("a row renamed by hand is one edit: nothing broken when no row links to it", async () => {
    const v = await workVault(true);
    await logExternalEdits(v.app, v.settings);
    const head = (await top(v)).version;
    await v.rename(`${P}/Shop.md`, `${P}/Shop (closed).md`);
    const commits = await logExternalEdits(v.app, v.settings);
    expect(commits).toEqual([{ table: "main.work.project", version: head + 1, operation: "EXTERNAL_EDIT" }]);
    expect((await top(v)).operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 1, metadataChanged: false, violations: 0 });
  });

  it("a row renamed by hand counts the rows of its table whose links to it now dangle", async () => {
    const v = await workVault(true);
    await logExternalEdits(v.app, v.settings);
    await v.rename(`${P}/Home.md`, `${P}/Home (2019).md`);
    await logExternalEdits(v.app, v.settings);
    // Site and Shop still link to [[Home]]
    expect((await top(v)).operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 1, metadataChanged: false, violations: 2 });
  });

  it("a row created by hand with its own id is a new row, checked like the others", async () => {
    const v = await workVault(true);
    await logExternalEdits(v.app, v.settings);
    v.write(`${P}/Lab.md`, "---\ntable: main.work.project\nid: 0199f000-0000-7000-8000-0000000000aa\nname: Lab\nkind: project\nbudget: -5\n---\n");
    await logExternalEdits(v.app, v.settings);
    expect((await top(v)).operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 0, metadataChanged: false, violations: 1 });
  });
});

describe("undo of a batch", () => {
  it("whose operations were all undone one by one marks the batch undone and writes nothing", async () => {
    const v = logVault();
    const api = createPublicApi(v.app, () => v.settings);
    const r = await api.batch({
      summary: "evening",
      operations: [
        { op: "insertRow", table: "log", values: { kind: "walk", occurred_at: "2026-09-27T19:00" } },
        { op: "updateRow", table: "log", path: "Daily/b.md", set: { metric_drinks: 1 } },
      ],
    });
    expect(r.ok).toBe(true);
    const members = r.steps.map((s) => s.migration_id!);
    for (const m of [...members].reverse()) expect((await api.undo(m)).ok).toBe(true);
    expect(v.exists(`${LOG_DIR}/2026/09/27/2026-09-27 walk.md`)).toBe(false);
    expect(fm(v, "Daily/b.md")).not.toHaveProperty("metric_drinks");
    const before = (await listMigrations(v.app, v.settings)).total;
    const u = await undoOperation(v.app, v.settings, r.migration_id!);
    expect(u).toEqual({ ok: true, op: "undo_migration", undoes: r.migration_id, conflicts: [], failed: [], touched: [] });
    expect((await listMigrations(v.app, v.settings)).total).toBe(before);
    const again = await undoOperation(v.app, v.settings, r.migration_id!);
    expect([again.ok, again.conflicts.map((c) => c.message)]).toEqual([false, ["migration already undone"]]);
  });
});

describe("helpers", () => {
  it("opSummary: ERROR when writes failed, WARN when refused, INFO when applied", () => {
    const failed = { ...emptyResult("insert_row", false), failed: [{ path: "Daily/a.md", error: "EBUSY" }] };
    expect(opSummary(failed).severity).toBe("ERROR");
    expect(opSummary({ ...emptyResult("insert_row", false), conflicts: [{ path: "x.md", message: "exists" }] }).severity).toBe("WARN");
    expect(opSummary({ ...emptyResult("insert_row", false), ok: true, migration_id: "m1" })).toEqual({
      severity: "INFO",
      attributes: {
        ok: true,
        notes_changed: 0,
        files_created: 0,
        files_moved: 0,
        files_deleted: 0,
        references_updated: 0,
        conflicts: 0,
        violating_rows: 0,
        failed: 0,
        planned_notes: 0,
        migration_id: "m1",
      },
    });
  });

  it("serializeOptions writes one alias as a list, one excluded folder as a string, and nothing for no options", () => {
    // create_table passes its options as given: one alias may be a plain string
    const given = { name: "task", aliases: "todo", exclude: ["Templates"] } as unknown as Parameters<typeof serializeOptions>[0];
    expect(serializeOptions(given)).toEqual([{ name: "task", aliases: ["todo"], exclude: "Templates" }]);
    expect(serializeOptions({ exclude: ["Templates", "Archive"], aliases: [] })).toEqual([{ exclude: ["Templates", "Archive"] }]);
    expect(serializeOptions({})).toEqual([]);
  });

  it("withSystemIdColumn puts the system id first and refuses an id column of another type", () => {
    const entry = withSystemIdColumn<{ columns: Record<string, unknown>[] }>({ columns: [{ name: "title", type: "string" }, { name: "id", type: "string", description: "mine" }] });
    expect(entry.columns.map((c) => [c.name, c.identity ?? null])).toEqual([
      ["id", "uuid"],
      ["title", null],
    ]);
    expect(() => withSystemIdColumn({ columns: [{ name: "id", type: "integer" }] })).toThrow(
      `"id" is reserved for the system row id (a UUID string); rename your "id" column first`,
    );
    expect(() => withSystemIdColumn({ columns: [{ name: "id", type: "integer" }] })).toThrow(OperationInputError);
  });
});
