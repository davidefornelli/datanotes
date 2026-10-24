/**
 * Write permissions of named tokens on the rows a write changes in other tables
 * (src/core/write-scope.ts, set by the guard in src/server/tokens.ts, checked in `finish`).
 *
 * A row write may change rows of tables its arguments do not name: `on_referenced: "set_null"`
 * clears their links, an inverse link column mirrors a link on the linked row, `align_relations`
 * writes the other side. A token whose `write` does not match such a table is refused with 403,
 * dry run or not, and nothing is written. A token whose `write` covers both tables, a token with
 * `write: ["*"]` and the owner write as before; schema changes (`ddl`) and undo (`maintain`) keep
 * writing what they wrote.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsUrl } from "../src/core/hints";
import { assertChangeSetWritable, changeSetTables, currentWriteScope, runWithWriteScope, WriteDeniedError, type WriteScope } from "../src/core/write-scope";
import { emptyChangeSet } from "../src/core/changeset";
import { loadMetastore } from "../src/core/metastore";
import { NOOP_TELEMETRY, setTelemetry, type AttrValue } from "../src/core/telemetry";
import { createDbVault } from "./helpers/db-vault";
import { PANTRY, rowsOf, setupReadTokens, WEIGHT, type ReadSetup } from "./helpers/read-tokens";

let logs: { body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  logs = [];
  setTelemetry({ log: (_severity, body, attributes) => void logs.push({ body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
afterEach(() => setTelemetry(NOOP_TELEMETRY));

/** Must have worked. */
async function owner(s: ReadSetup, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await s.op("owner", op, args);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as Record<string, unknown>;
}

/** Every file of the vault and its text: a refused write leaves it as it was. */
function files(s: ReadSetup): Record<string, string> {
  return Object.fromEntries(s.v.list().map((p) => [p, s.v.read(p)]));
}

/**
 * The refusal of a write that changes rows of `table`, which `token` may not write: named to a
 * token that may read it (legacy), unnamed to one that may not (cook does not read health).
 */
function writeRefusal(token: string, table: string) {
  const named = token !== "cook";
  return {
    status: 403,
    json: named
      ? {
          error: `token ${token} may not write ${table}: this write changes rows of it`,
          hint: `Nothing was written. The write changes rows of ${table} (set_null, an inverse link or align_relations), so the token needs write on it too: the owner adds "${table}" (or a wider pattern) to the token's "write" with tokens/update/. Or change the write so it leaves that table alone.`,
          docs: docsUrl("tokenWrite"),
        }
      : {
          error: `token ${token} may not write a table it may not read: this write changes rows of it`,
          hint: `Nothing was written. The write changes rows of a table this token may not read (set_null, an inverse link or align_relations). The owner can add that table to the token's "read" and "write" with tokens/update/. Or change the write so it leaves that table alone.`,
          docs: docsUrl("tokenWrite"),
        },
  };
}

/** Tokens beyond the fixture's: `both` writes pantry and weight, `all` every table, `builder` pantry with ddl, `keeper` pantry with maintain. */
async function moreTokens(s: ReadSetup): Promise<void> {
  for (const t of [
    { name: "both", read: ["personal.*"], write: [PANTRY, WEIGHT] },
    { name: "all", write: ["*"] },
    { name: "builder", write: [PANTRY], ddl: true },
    { name: "keeper", write: [PANTRY], maintain: true },
  ]) {
    const r = await s.owner("/tokens/create/", t);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
}

/** A weight link into the pantry (`staple`): the light weigh-in links to the pantry row `salt`. */
async function withStaple(s: ReadSetup): Promise<void> {
  await owner(s, "add_column", { table: WEIGHT, column: { name: "staple", type: "link", ref: PANTRY, description: "The staple eaten before" } });
  await owner(s, "insert_row", { table: PANTRY, values: { item: "salt", qty: 1 } });
  await owner(s, "update_row", { table: WEIGHT, path: s.paths.light, set: { staple: "[[salt]]" } });
}

/** An inverse pair between pantry (`weighed`) and weight (`bought`): a pantry write edits a weight row. */
async function withInverse(s: ReadSetup): Promise<void> {
  await owner(s, "add_column", { table: WEIGHT, column: { name: "bought", type: "list", items: "link", ref: PANTRY, description: "What was bought for this weigh-in" } });
  await owner(s, "add_column", { table: PANTRY, column: { name: "weighed", type: "link", ref: WEIGHT, inverse: "bought", description: "The weigh-in it was bought for" } });
}

/** The pantry row flour links to the heavy weigh-in by hand: the weight row does not link back yet. */
function unalignedFlour(s: ReadSetup): void {
  const text = s.v.read(s.paths.flour);
  s.v.write(s.paths.flour, text.replace(/^---\n/, `---\nweighed: "[[Morning weigh-in]]"\n`));
}

const SET_NULL = { table: PANTRY, where: { item: "salt" }, on_referenced: "set_null" };
const INVERSE = { table: PANTRY, values: { item: "milk", weighed: "[[Morning weigh-in]]" } };
const ALIGN = { table: PANTRY };

/** The three writes that change a weight row, each with its vault. */
const CASES: { name: string; op: string; args: Record<string, unknown>; setup(s: ReadSetup): Promise<void>; written(s: ReadSetup): Promise<boolean> }[] = [
  {
    name: "delete_rows with set_null",
    op: "delete_rows",
    args: SET_NULL,
    setup: withStaple,
    written: async (s) => (rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { kg: 79 } }))[0]!.staple ?? null) === null,
  },
  {
    name: "insert_row with an inverse link",
    op: "insert_row",
    args: INVERSE,
    setup: withInverse,
    written: async (s) => JSON.stringify(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { kg: 81.5 } }))[0]!.bought ?? null) === JSON.stringify(["[[milk]]"]),
  },
  {
    name: "align_relations",
    op: "align_relations",
    args: ALIGN,
    setup: async (s) => {
      await withInverse(s);
      unalignedFlour(s);
    },
    written: async (s) => JSON.stringify(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { kg: 81.5 } }))[0]!.bought ?? null) === JSON.stringify(["[[flour]]"]),
  },
];

describe("a row write that changes rows of a table the token may not write", () => {
  for (const c of CASES) {
    it(`${c.name}: refused with 403, dry run or not, and nothing is written`, async () => {
      const s = await setupReadTokens();
      await c.setup(s);
      const before = files(s);
      // cook reads food and writes the pantry; legacy reads everything and writes food
      for (const token of ["cook", "legacy"] as const) {
        for (const dry_run of [true, false]) {
          expect(await s.op(token, c.op, { ...c.args, dry_run }), `${token} ${dry_run}`).toEqual(writeRefusal(token, WEIGHT));
        }
      }
      expect(files(s)).toEqual(before);
      expect(await c.written(s)).toBe(false);
    });

    it(`${c.name}: written by a token whose write covers both tables`, async () => {
      const s = await setupReadTokens();
      await moreTokens(s);
      await c.setup(s);
      const dry = await s.as("both", `/operations/${c.op}/`, { ...c.args, dry_run: true });
      expect(dry.status, JSON.stringify(dry.json)).toBe(200);
      const r = await s.as("both", `/operations/${c.op}/`, c.args);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(await c.written(s)).toBe(true);
    });

    it(`${c.name}: written by the owner and by a token with write ["*"]`, async () => {
      for (const who of ["owner", "all"] as const) {
        const s = await setupReadTokens();
        await moreTokens(s);
        await c.setup(s);
        const r = who === "owner" ? await s.op("owner", c.op, c.args) : await s.as("all", `/operations/${c.op}/`, c.args);
        expect(r.status, `${who} ${JSON.stringify(r.json)}`).toBe(200);
        expect(await c.written(s), who).toBe(true);
      }
    });
  }

  it("update_rows and merge_rows mirror their links too: refused the same way", async () => {
    const s = await setupReadTokens();
    await withInverse(s);
    const before = files(s);
    expect(await s.op("cook", "update_rows", { table: PANTRY, where: { item: "flour" }, set: { weighed: "[[Morning weigh-in]]" } })).toEqual(writeRefusal("cook", WEIGHT));
    expect(await s.op("cook", "merge_rows", { table: PANTRY, on: ["item"], rows: [{ item: "eggs", weighed: "[[Morning weigh-in]]" }] })).toEqual(writeRefusal("cook", WEIGHT));
    expect(files(s)).toEqual(before);
    // a write that changes only pantry rows goes through
    expect((await s.op("cook", "update_rows", { table: PANTRY, where: { item: "flour" }, set: { qty: 3 } })).status).toBe(200);
  });

  it("a batch: refused with 403 as the step is, nothing left written, in a dry run too", async () => {
    const s = await setupReadTokens();
    await withInverse(s);
    const before = files(s);
    const operations = [
      { op: "insert_row", table: PANTRY, values: { item: "oats" } },
      { op: "insert_row", ...INVERSE },
    ];
    for (const dry_run of [false, true]) {
      const r = await s.op("cook", "batch", { operations, dry_run });
      const refusal = writeRefusal("cook", WEIGHT).json;
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ ok: false, dry_run, error: `operation 1: ${refusal.error}`, hint: refusal.hint, docs: refusal.docs });
      expect((r.json as { steps: unknown[] }).steps[1]).toMatchObject({ index: 1, ok: false, ...refusal });
      if (!dry_run) expect(r.json).toMatchObject({ failed_at: 1, rolled_back: true });
    }
    expect(files(s)).toEqual(before);
    // a batch refused for another reason keeps its 422
    const other = await s.op("cook", "batch", { operations: [operations[0], { op: "insert_row", table: PANTRY, values: { qty: 1 } }] });
    expect(other.status).toBe(422);
    expect(files(s)).toEqual(before);
  });

  it("answers 503 to a row write of a token with limited write where no scope can be carried", async () => {
    const s = await setupReadTokens({ readScopeSupported: false });
    const unsupported = {
      status: 503,
      json: {
        error: "write permissions need Node's AsyncLocalStorage",
        hint: `This token's "write" patterns limit the tables its writes may change, which this runtime cannot enforce: run the engine on Node (datanotes serve), or write with a token whose "write" is ["*"].`,
        docs: docsUrl("tokenWrite"),
      },
    };
    expect(await s.op("legacy", "insert_row", { table: PANTRY, values: { item: "milk" } })).toEqual(unsupported);
    expect(await s.op("legacy", "batch", { operations: [{ op: "insert_row", table: PANTRY, values: { item: "milk" } }] })).toEqual(unsupported);
    // its reads are served (it reads everything), and so are the owner's writes
    expect((await s.op("legacy", "select_rows", { table: WEIGHT })).status).toBe(200);
    expect((await s.op("owner", "insert_row", { table: PANTRY, values: { item: "milk" } })).status).toBe(200);
    expect(logs.filter((l) => l.body === "datanotes token refused").at(-1)?.attributes).toEqual({ token_name: "legacy", "http.route": "/operations/batch/", reason: "write permissions need Node's AsyncLocalStorage" });
  });
});

describe("what the write scope leaves as it was", () => {
  it("a schema change of a ddl token and an undo of a maintain token still rewrite rows of other tables", async () => {
    const s = await setupReadTokens();
    await moreTokens(s);
    // ddl: renaming a weight column rewrites every weight row
    const rename = await s.as("builder", "/operations/rename_column/", { table: WEIGHT, from_column: "kg", to_column: "kilos" });
    expect(rename.status, JSON.stringify(rename.json)).toBe(200);
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { label: "Morning weigh-in" } }))[0]).toMatchObject({ kilos: 81.5 });
    // maintain: undoing the owner's write of a weight row
    const w = await owner(s, "update_row", { table: WEIGHT, path: s.paths.heavy, set: { kilos: 82 } });
    const undo = await s.as("keeper", "/operations/undo_migration/", { migration_id: w.migration_id });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect(rowsOf(await s.op("owner", "select_rows", { table: WEIGHT, where: { label: "Morning weigh-in" } }))[0]).toMatchObject({ kilos: 81.5 });
    // a row write of theirs is checked like any other
    expect((await s.as("builder", "/operations/update_row/", { table: WEIGHT, path: s.paths.heavy, set: { kilos: 80 } })).status).toBe(403);
  });

  it("adopting a free note into a writable table is allowed: a free note is no table's row", async () => {
    const s = await setupReadTokens();
    s.v.write("Inbox/rice.md", "---\nitem: rice\n---\n");
    const r = await s.op("legacy", "adopt_rows", { table: PANTRY, paths: ["Inbox/rice.md"] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(rowsOf(await s.op("owner", "select_rows", { table: PANTRY, where: { item: "rice" } }))).toHaveLength(1);
  });

  it("no scope outside a request, nested scopes, and the tables of a change set", async () => {
    expect(currentWriteScope()).toBeNull();
    const cook: WriteScope = { token: "cook", patterns: [PANTRY] };
    runWithWriteScope(cook, () => {
      expect(currentWriteScope()).toBe(cook);
      runWithWriteScope(null, () => expect(currentWriteScope()).toBeNull());
    });
    expect(runWithWriteScope(null, () => 1)).toBe(1);
    const s = await setupReadTokens();
    const model = (await loadMetastore(s.v.app, s.v.settings))!.model;
    const cs = emptyChangeSet("delete_rows", "x");
    cs.deletes.push(s.paths.light, s.paths.diary);
    cs.moves.push({ from: s.paths.eggs, to: "Datanotes/personal/food/pantry/_archive/eggs.md" });
    cs.creates.push({ path: "Inbox/x.md", content: "no front matter" });
    // a no-op edit counts for nothing; an edit whose front matter names no table, by its note's table
    cs.edits.push({ path: "Inbox/meals.md", before: [], after: [] }, { path: s.paths.flour, before: [], after: [["qty", 2]] });
    expect([...changeSetTables(s.v.app, s.v.settings, model, cs)].sort()).toEqual([PANTRY, WEIGHT]);
    expect(new WriteDeniedError("cook", WEIGHT).table).toBe(WEIGHT);
    expect(new WriteDeniedError("cook", null).table).toBeNull();
    // under a scope: a change set that is no row write, or a vault without a database, passes
    await runWithWriteScope(cook, async () => {
      await expect(assertChangeSetWritable(s.v.app, s.v.settings, Object.assign(emptyChangeSet("rename_column", "x"), { deletes: [s.paths.light] }))).resolves.toBeUndefined();
      const bare = createDbVault({});
      await expect(assertChangeSetWritable(bare.app, bare.settings, cs)).resolves.toBeUndefined();
      await expect(assertChangeSetWritable(s.v.app, s.v.settings, cs)).rejects.toThrow(`token cook may not write ${WEIGHT}`);
    });
  });
});
