/**
 * The extension registry (`src/server/extensions.ts`) without sockets: requests run through the
 * same chain the HTTP server uses (actor, permission guard, dispatch, real route handlers).
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithActor, type Actor } from "../src/core/actor";
import { NOOP_TELEMETRY, setTelemetry, type AttrValue } from "../src/core/telemetry";
import type { InstalledExtension } from "../src/api/extension-record";
import { ExtensionRegistry } from "../src/server/extensions";
import { TokenRegistry } from "../src/server/tokens";
import { createHandlers, dispatch, Forbidden, type Handler, type HandlerResponse } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { guided } from "./helpers/guidance";

const YAML = `catalogs:
  work:
    schemas:
      planning:
        tables:
          person:
            options: { filename: "{name}" }
            columns:
              - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
              - { name: name, type: string, required: true }
`;

let logs: { severity: string; body: string; attributes?: Record<string, AttrValue> }[] = [];
beforeEach(() => {
  logs = [];
  setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
});
afterEach(() => setTelemetry(NOOP_TELEMETRY));
const logged = (body: string) => logs.filter((l) => l.body === body);

const WHERE = "https://datanotes.dev/administration/extensions.md#where-extensions-live";
const HINT = "datanotes extension install writes this record; to change an extension, run datanotes extension update or remove.";

/** A complete record for the `books` fixture extension. */
function valid(over: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    name: "books",
    version: "0.1.0",
    description: "Books and their readers.",
    api: 1,
    source: { kind: "git", url: "https://example.com/books.git", ref: "v0.1.0" },
    commit: "a".repeat(40),
    manifest_sha256: "b".repeat(64),
    entry_sha256: "c".repeat(64),
    token: "ext-books",
    tables: { person: { table: "work.planning.person", owned: false }, book: { table: "work.books.book", owned: true } },
    tools: ["list_books"],
    write: ["work.books.book"],
    migration_id: "m1",
    installed_at: "2026-10-19T09:00:00.000Z",
    updated_at: "2026-10-19T09:00:00.000Z",
    previous: null,
    ...over,
  };
}

interface Setup {
  v: DbVault;
  registry: ExtensionRegistry;
  owner(route: string, body?: unknown): Promise<HandlerResponse>;
  as(token: string, route: string, body?: unknown): Promise<HandlerResponse>;
  file(): unknown;
}

function setup(): Setup {
  const v = createDbVault({ [METASTORE]: YAML });
  const tokens = new TokenRegistry({ app: v.app, getSettings: () => v.settings });
  const registry = new ExtensionRegistry({ app: v.app, getSettings: () => v.settings });
  const routes: Record<string, Handler> = { ...createHandlers(v.app, () => v.settings), ...tokens.handlers(), ...registry.handlers() };
  const guarded = tokens.guard(dispatch);
  const run = (actor: Actor, route: string, body: unknown) => runWithActor(actor, () => guarded(route, routes[route]!, body));
  return {
    v,
    registry,
    owner: (route, body = {}) => run({ auth: "owner" }, route, body),
    as: (token, route, body = {}) => run({ harness: token, auth: token }, route, body),
    file: () => JSON.parse(v.read("store:extensions.json")),
  };
}

const bad = (error: string) => ({ status: 400, json: guided(error, { hint: HINT, docs: WHERE }) });

describe("extension registry: record and list", () => {
  it("the owner records an extension and any token lists it", async () => {
    const s = setup();
    const r = valid();
    expect(await s.owner("/extensions/record/", r)).toEqual({ status: 200, json: { extension: r } });
    await s.owner("/tokens/create/", { name: "reader" });

    const expected = { database_id: s.v.settings.databaseId || null, extensions: [r] };
    expect(await s.owner("/extensions/")).toEqual({ status: 200, json: expected });
    expect(await s.as("reader", "/extensions/")).toEqual({ status: 200, json: expected });
    expect(s.file()).toEqual([r]);
    expect(logged("datanotes extension recorded")).toEqual([{ severity: "INFO", body: "datanotes extension recorded", attributes: { extension_name: "books", extension_version: "0.1.0" } }]);
  });

  it("answers the database id the settings hold", async () => {
    const s = setup();
    s.v.settings.databaseId = "db-1";
    expect((await s.owner("/extensions/")).json).toEqual({ database_id: "db-1", extensions: [] });
  });

  it("a record replaces the one of the same name, and the list is sorted", async () => {
    const s = setup();
    await s.owner("/extensions/record/", valid({ name: "zeta", token: "ext-zeta" }));
    await s.owner("/extensions/record/", valid({ name: "alpha", token: "ext-alpha" }));
    await s.owner("/extensions/record/", valid({ name: "zeta", token: "ext-zeta", version: "0.2.0" }));
    const list = ((await s.owner("/extensions/")).json as { extensions: InstalledExtension[] }).extensions;
    expect(list.map((e) => e.name)).toEqual(["alpha", "zeta"]);
    expect(list[1]!.version).toBe("0.2.0");
    expect((s.file() as InstalledExtension[]).map((e) => e.name)).toEqual(["alpha", "zeta"]);
  });

  it("keeps unknown fields and a nested previous record", async () => {
    const s = setup();
    const r = { ...valid({ previous: valid({ version: "0.0.9" }) }), future_field: 1 };
    await s.owner("/extensions/record/", r);
    expect(s.file()).toEqual([r]);
    expect(s.registry.get("books")).toEqual(r);
    expect(s.registry.get("nope")).toBeUndefined();
  });

  it("two records saved at once both stay", async () => {
    const s = setup();
    await Promise.all([s.registry.put(valid({ name: "one-ext" })), s.registry.put(valid({ name: "two-ext" }))]);
    expect((s.file() as InstalledExtension[]).map((e) => e.name)).toEqual(["one-ext", "two-ext"]);
  });

  it("stop waits for the last save", async () => {
    const s = setup();
    void s.registry.put(valid());
    await Promise.resolve();
    await s.registry.stop();
    await s.registry.stop();
    expect(s.file()).toHaveLength(1);
  });

  it("a registry read back by a restarted engine lists the same records", async () => {
    const s = setup();
    await s.owner("/extensions/record/", valid());
    const again = new ExtensionRegistry({ app: s.v.app, getSettings: () => s.v.settings });
    await again.load();
    expect(again.list().map((e) => e.name)).toEqual(["books"]);
  });
});

describe("extension registry: invalid records", () => {
  const without = (k: string): Record<string, unknown> => {
    const { [k]: _gone, ...rest } = valid() as unknown as Record<string, unknown>;
    return rest;
  };
  const NAME = '"name" must be 2 to 40 lowercase letters, digits or -, starting with a letter';

  it.each<[string, unknown, string]>([
    ["a bad name", { ...valid(), name: "Books" }, NAME],
    ["a missing version", without("version"), '"version" must be a non-empty string'],
    ["a missing description", without("description"), '"description" must be a string'],
    ["an api of 0", { ...valid(), api: 0 }, '"api" must be an integer of 1 or more'],
    ["a source that is not an object", { ...valid(), source: "git" }, '"source" must be an object'],
    ["tables as a list", { ...valid(), tables: [] }, '"tables" must be an object of roles'],
    ["a table without table", { ...valid(), tables: { person: { owned: true } } }, '"tables" must be an object of roles'],
    ["a table that is not an object", { ...valid(), tables: { person: 3 } }, '"tables" must be an object of roles'],
    ["tools holding a number", { ...valid(), tools: [1] }, '"tools" must be a list of strings'],
    ["write that is not a list", { ...valid(), write: "x" }, '"write" must be a list of strings'],
    ["source.kind npm", { ...valid(), source: { kind: "npm" } }, '"source.kind" must be "git" or "local"'],
    ["migration_id 5", { ...valid(), migration_id: 5 }, '"migration_id" must be a string or null'],
    ["a previous record that is not valid", { ...valid(), previous: { name: "x" } }, 'invalid'],
    ["a previous that is not an object", { ...valid(), previous: 3 }, '"previous" must be an object'],
  ])("refuses %s", async (_title, body, problem) => {
    const s = setup();
    const r = await s.owner("/extensions/record/", body);
    expect(r.status).toBe(400);
    const error = (r.json as { error: string }).error;
    expect(error.startsWith("invalid extension record: ")).toBe(true);
    if (problem !== "invalid") expect(error).toContain(problem);
    expect(r.json).toEqual(guided(error, { hint: HINT, docs: WHERE }));
    expect(s.registry.list()).toEqual([]);
  });

  it("names the nested problems of a previous record with a prefix", async () => {
    const s = setup();
    const r = await s.owner("/extensions/record/", { ...valid(), previous: { name: "x" } });
    const error = (r.json as { error: string }).error;
    expect(error).toContain(`"previous.name" must be 2 to 40 lowercase letters, digits or -, starting with a letter`);
    expect(error).toContain('"previous.version" must be a non-empty string');
    expect(error).toContain('"previous.source" must be an object');
  });

  it("a body that is not an object is refused by the record check", async () => {
    const s = setup();
    const { recordProblems } = await import("../src/api/extension-record");
    expect(recordProblems(null)).toEqual(['"record" must be an object']);
    expect(recordProblems([])).toEqual(['"record" must be an object']);
    expect(recordProblems(valid())).toEqual([]);
    expect(s.registry.list()).toEqual([]);
  });

  it("refuses a body over 1 000 000 characters", async () => {
    const s = setup();
    expect(await s.owner("/extensions/record/", { ...valid(), description: "x".repeat(1_000_001) })).toEqual(bad("the record is larger than 1000000 characters"));
    expect(s.registry.list()).toEqual([]);
  });
});

describe("extension registry: who may change it", () => {
  it("named tokens may not record or delete", async () => {
    const s = setup();
    await s.owner("/extensions/record/", valid());
    const before = s.v.read("store:extensions.json");
    await s.owner("/tokens/create/", { name: "admin", maintain: true });
    for (const [route, body] of [["/extensions/record/", valid({ name: "other" })], ["/extensions/delete/", { name: "books" }]] as const) {
      const r = await s.as("admin", route, body);
      expect(r.status).toBe(403);
      expect((r.json as { error: string }).error).toBe(`token admin may not call ${route} (reserved to the owner)`);
    }
    expect(s.v.read("store:extensions.json")).toBe(before);
  });

  it("the handlers check the owner themselves", async () => {
    const s = setup();
    const routes = s.registry.handlers();
    for (const [route, body] of [["/extensions/record/", valid()], ["/extensions/delete/", { name: "books" }]] as const) {
      let error: unknown;
      try {
        await runWithActor({ auth: "admin" }, () => routes[route]!(body as unknown as Record<string, unknown>));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Forbidden);
      expect((error as Error).message).toBe("reserved to the owner");
    }
  });
});

describe("extension registry: delete", () => {
  it("forgets a record", async () => {
    const s = setup();
    await s.owner("/extensions/record/", valid());
    expect(await s.owner("/extensions/delete/", { name: "books" })).toEqual({ status: 200, json: { deleted: true } });
    expect(await s.owner("/extensions/delete/", { name: "books" })).toEqual({ status: 200, json: { deleted: false } });
    expect(s.file()).toEqual([]);
    expect(logged("datanotes extension removed")).toEqual([{ severity: "INFO", body: "datanotes extension removed", attributes: { extension_name: "books" } }]);
  });

  it("needs a name", async () => {
    const s = setup();
    expect(await s.owner("/extensions/delete/", {})).toEqual(bad('"name" is required'));
    expect(await s.owner("/extensions/delete/", { name: "" })).toEqual(bad('"name" is required'));
    expect(await s.owner("/extensions/delete/", { name: 4 })).toEqual(bad('"name" is required'));
  });
});

describe("extension registry: the registry file", () => {
  it.each([
    ["a file that is not JSON", "{"],
    ["a file that is not a list", "{}"],
  ])("counts %s as empty and logs why", async (_title, text) => {
    const s = setup();
    s.v.write("store:extensions.json", text);
    expect(await s.owner("/extensions/")).toEqual({ status: 200, json: { database_id: s.v.settings.databaseId || null, extensions: [] } });
    expect(logged("datanotes could not read the extension registry")).toHaveLength(1);
    expect(logged("datanotes could not read the extension registry")[0]!.severity).toBe("WARN");
  });

  it("keeps the records in memory when the file cannot be saved", async () => {
    const s = setup();
    fs.rmSync(s.v.storeRoot, { recursive: true });
    fs.writeFileSync(s.v.storeRoot, "a file where the store folder should be");
    await s.registry.put(valid());
    expect(s.registry.list()).toHaveLength(1);
    const saves = logged("datanotes could not save extensions.json");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.severity).toBe("WARN");
    expect(String(saves[0]!.attributes?.error)).toMatch(/^E(NOTDIR|NOENT|EXIST)/);
  });
});
