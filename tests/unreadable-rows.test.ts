/**
 * Rows whose front matter a hand edit broke (YAML that no longer parses): the vault's index has no
 * properties for them, so every read leaves them out. They are reported instead: by check_table
 * (code `unreadable`), by the change feed (a `kind: unreadable` event) and by describe_database
 * (`unreadable_count`). The transaction log keeps their last readable state (transaction-log-edges).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { ChangeFeed, wireEvent } from "../src/core/change-feed";
import { INDEX_RETRY } from "../src/core/engine";
import { docsUrl, violationGuidance } from "../src/core/hints";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { frontmatterError, rawFrontmatterValue, unreadableMessage, unreadableRowOf, unreadableRows } from "../src/core/unreadable";
import { createHandlers, dispatch } from "../src/server/rest";
import { logVault, LOG_DIR, type DbVault } from "./helpers/db-vault";
import { parseMetastore } from "../src/core/metastore";

INDEX_RETRY.delayMs = 1;
afterEach(() => setTelemetry(NOOP_TELEMETRY));

const A = "Daily/a.md";
const A_ID = "01a0f000-0000-7000-8000-00000000000a";

/** Like Obsidian: the index has no properties for a note whose YAML it cannot parse. */
function tolerantIndex(v: DbVault): void {
  const cache = v.app.metadataCache as unknown as { getFileCache(f: unknown): unknown };
  const real = cache.getFileCache.bind(cache);
  vi.spyOn(cache, "getFileCache").mockImplementation((f: unknown) => {
    try {
      return real(f);
    } catch {
      return {};
    }
  });
}

function engine(v: DbVault) {
  tolerantIndex(v);
  const handlers = createHandlers(v.app, () => v.settings);
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const req = operationRequest(op, args);
    const route = req.path.slice(ROUTE_PREFIX.length);
    const r = (await dispatch(route, handlers[route]!, req.body)) as { status: number; json: Record<string, any> };
    expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json;
  };
  return { v, call };
}

const broken = (v: DbVault) => v.write(A, v.read(A).replace("kind: alcohol", "kind: [alcohol"));

describe("the front matter of a note", () => {
  it("cannot be read: why, and the table its own `table:` line names", () => {
    const bad = "---\ntable: main.public.log\nkind: [alcohol\n---\nA\n";
    expect(frontmatterError(bad)).toEqual(expect.any(String));
    expect(frontmatterError("---\nkind: walk\n---\n")).toBeNull();
    expect(frontmatterError("No properties.\n")).toBeNull();
    expect(rawFrontmatterValue(bad, "table")).toBe("main.public.log");
    expect(rawFrontmatterValue('---\n"table": "log"\nx: [\n---\n', "table")).toBe("log");
    expect(rawFrontmatterValue("---\n'table': log # the table\nx: [\n---\n", "table")).toBe("log");
    expect(rawFrontmatterValue("---\ntable: 'log\nx: [\n---\n", "table")).toBe("'log");
    expect(rawFrontmatterValue("---\nkind: walk\n---\n", "table")).toBeUndefined();
    expect(rawFrontmatterValue("No properties.\n", "table")).toBeUndefined();
    expect(unreadableMessage("Nested mappings are not allowed at line 2, column 8:\n\nx: a: b\n")).toBe(
      "the front matter cannot be read, so the row is left out of every read: Nested mappings are not allowed at line 2, column 8:",
    );
  });

  it("makes no row when it names no table, an unknown one, or lies in the table's archive", () => {
    const v = logVault();
    const model = parseMetastore(v.read("Datanotes/metastore.yaml"));
    const s = v.settings;
    expect(unreadableRowOf(model, s, "Notes/x.md", "---\nkind: [walk\n---\n")).toBeNull();
    expect(unreadableRowOf(model, s, "Notes/x.md", "---\ntable: main.public.nothing\nkind: [walk\n---\n")).toBeNull();
    expect(unreadableRowOf(model, s, `${LOG_DIR}/_archive/x.md`, "---\ntable: log\nkind: [walk\n---\n")).toBeNull();
    expect(unreadableRowOf(model, s, "Notes/x.md", "---\ntable: log\nkind: walk\n---\n")).toBeNull();
    expect(unreadableRowOf(model, s, "Notes/x.md", "---\ntable: log\nkind: [walk\n---\n")).toEqual({ path: "Notes/x.md", table: "main.public.log", error: expect.any(String) });
  });
});

describe("check_table and describe_database", () => {
  it("report the row with code unreadable and count it apart, until it is fixed", async () => {
    const e = engine(logVault({ "Notes/plain-broken.md": "---\nx: [\n---\n", [`${LOG_DIR}/_archive/old.md`]: "---\ntable: log\nkind: [walk\n---\n" }));
    broken(e.v);
    expect((await e.call("select_rows", { table: "log" })).total).toBe(1);
    const one = await e.call("check_table", { table: "log" });
    expect(one.rows_checked).toBe(2);
    expect(one.violations).toEqual([{ path: A, violations: [{ code: "unreadable", message: expect.stringMatching(/^the front matter cannot be read, so the row is left out of every read: \S/) }] }]);
    const all = await e.call("check_table", {});
    expect(all.violations).toEqual([{ path: A, table: "main.public.log", violations: [expect.objectContaining({ code: "unreadable" })] }]);
    const table = (d: Record<string, any>) => d.catalogs[0].schemas[0].tables[0];
    expect(table(await e.call("describe_database"))).toMatchObject({ qualified: "main.public.log", row_count: 1, unreadable_count: 1 });
    expect(await unreadableRows(e.v.app, e.v.settings, parseMetastore(e.v.read("Datanotes/metastore.yaml")), "main.public.other")).toEqual([]);
    // fixed: a row again, nothing to report
    e.v.write(A, e.v.read(A).replace("kind: [alcohol", "kind: alcohol"));
    expect((await e.call("check_table", { table: "log" })).violations).toEqual([]);
    expect(table(await e.call("describe_database"))).not.toHaveProperty("unreadable_count");
  });

  it("the violation's guidance says to fix the YAML and links its page", () => {
    expect(violationGuidance("unreadable")).toEqual({ hint: expect.stringMatching(/fix the YAML/), docs: docsUrl("unreadable") });
  });
});

describe("the change feed", () => {
  function logs() {
    const out: { body: string; attrs: Record<string, unknown> }[] = [];
    setTelemetry({ log: (_s, body, attrs = {}) => out.push({ body, attrs }), flush: async () => {} });
    return out;
  }

  it("records an unreadable event for a row a hand edit broke, keeps its state, and compares its fix with it", async () => {
    const v = logVault();
    tolerantIndex(v);
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const lines = logs();
    broken(v);
    feed.touch(A);
    await feed.flush();
    const [ev, ...rest] = (await feed.read()).events;
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({ op: "unreadable", table: "main.public.log", path: A, id: A_ID, source: "external" });
    expect(wireEvent(ev!)).toMatchObject({ kind: "unreadable", row_id: A_ID, violations: [{ path: A, violations: [{ code: "unreadable", message: expect.stringMatching(/^the front matter cannot be read/) }] }] });
    expect(lines.filter((l) => l.body === "datanotes hand edit left a row unreadable").map((l) => l.attrs.path)).toEqual([A]);
    // a consumer of other kinds does not get it
    expect((await feed.read({ ops: ["update", "delete"] })).events).toEqual([]);
    // fixed with another value: an update of the last readable state
    v.write(A, v.read(A).replace("kind: [alcohol", "kind: alcohol").replace("metric_drinks: 7", "metric_drinks: 2"));
    feed.touch(A);
    await feed.flush();
    const fixed = (await feed.read({ since: ev!.seq })).events;
    expect(fixed.map((e) => [e.op, e.changes])).toEqual([["update", { metric_drinks: { before: 7, after: 2 } }]]);
    await feed.stop();
  });

  it("a new note that names a table but cannot be read is unreadable, then an insert once fixed; a plain broken note is nothing", async () => {
    const v = logVault();
    tolerantIndex(v);
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const N = "Notes/new.md";
    v.write(N, "---\ntable: log\nkind: [walk\noccurred_at: 2026-09-27T10:00\n---\n");
    feed.touch(N);
    v.write("Notes/plain.md", "---\nx: [\n---\n");
    feed.touch("Notes/plain.md");
    await feed.flush();
    const first = (await feed.read()).events;
    expect(first.map((e) => [e.op, e.path, e.table, e.id])).toEqual([["unreadable", N, "main.public.log", undefined]]);
    v.write(N, "---\ntable: log\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n");
    feed.touch(N);
    await feed.flush();
    expect((await feed.read({ since: first[0]!.seq })).events.map((e) => [e.op, e.path])).toEqual([["insert", N]]);
    await feed.stop();
  });

  it("list_changes takes the kind unreadable", async () => {
    const v = logVault();
    const feed = new ChangeFeed(v.app, () => v.settings);
    await feed.start();
    const { createPublicApi } = await import("../src/core/public-api");
    const api = createPublicApi(v.app, () => v.settings, async () => {}, undefined as never, () => feed);
    const handlers = createHandlers(v.app, () => v.settings, async () => {}, undefined as never, api);
    const req = operationRequest("list_changes", { kinds: ["unreadable"] });
    const r = (await dispatch(req.path.slice(ROUTE_PREFIX.length), handlers[req.path.slice(ROUTE_PREFIX.length)]!, req.body)) as { status: number; json: Record<string, any> };
    expect([r.status, r.json.events]).toEqual([200, []]);
    await feed.stop();
  });
});
