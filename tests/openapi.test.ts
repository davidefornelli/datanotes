import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { openApiDocument } from "../src/server/openapi";
import { recordProblems } from "../src/api/extension-record";
import { DOCS_CSP } from "../src/server/docs-ui";
import { HttpApiServer, newToken } from "../src/server/http-server";
import { createHandlers } from "../src/server/rest";
import { startService, type RunningService } from "../src/node/service";
import { logVault, METASTORE, withTables } from "./helpers/db-vault";
import { seedStoreSettings } from "./helpers/store-settings";

type Doc = {
  openapi: string;
  servers: { url: string }[];
  tags: { name: string }[];
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown>; parameters: Record<string, unknown> };
  paths: Record<string, Record<string, { operationId: string; tags?: string[]; security?: unknown[]; responses: Record<string, unknown> }>>;
};

const doc = openApiDocument("1.2.3") as unknown as Doc;
const ops = Object.entries(doc.paths).flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => ({ path: p, method: m, op })));

/** Every `$ref` in a value. */
function refs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string") out.push(x);
      else refs(x, out);
    }
  }
  return out;
}

describe("OpenAPI document", () => {
  it("is structurally valid: responses everywhere, unique operationIds, resolvable $refs, known tags", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "/" }]);
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set(doc.tags.map((t) => t.name));
    for (const { path: p, op } of ops) {
      expect(Object.keys(op.responses).length, p).toBeGreaterThan(0);
      expect(op.responses["200"], p).toBeDefined();
      for (const status of Object.keys(op.responses)) expect(status, p).toMatch(/^[1-5]\d\d$/);
      expect(op.tags?.length, p).toBe(1);
      expect(tags.has(op.tags![0]!), p).toBe(true);
      // path parameters are declared
      for (const m of p.matchAll(/\{(\w+)\}/g)) {
        expect((op as { parameters?: { name: string; in: string }[] }).parameters?.some((x) => x.in === "path" && x.name === m[1]), p).toBe(true);
      }
    }
    for (const r of refs(doc)) {
      const m = /^#\/components\/(schemas|responses|parameters)\/([A-Za-z0-9._-]+)$/.exec(r);
      expect(m, r).not.toBeNull();
      expect((doc.components as Record<string, Record<string, unknown>>)[m![1]!]![m![2]!], r).toBeDefined();
    }
    for (const name of Object.keys(doc.components.schemas)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("documents every routed catalogue operation, with the errors it can really answer", () => {
    for (const t of OPERATIONS) {
      if (["read_note", "list_directory", "search_simple"].includes(t.name)) continue;
      expect(ops.some((o) => o.op.operationId === t.name || ((o.op as { "x-mcp-tools"?: string[] })["x-mcp-tools"] ?? []).includes(t.name)), t.name).toBe(true);
    }
    const r = (p: string, m = "post") => doc.paths[p]![m]!.responses;
    // a refused write: 422 with the operation's result; one failed and rolled back: 503; undo: 409
    expect(Object.keys(r("/datanotes/operations/insert_row/"))).toEqual(["200", "400", "401", "403", "404", "409", "422", "500", "503"]);
    expect(Object.keys(r("/datanotes/operations/undo_migration/"))).toContain("409");
    expect(Object.keys(r("/datanotes/operations/undo_migration/"))).not.toContain("422");
    expect(Object.keys(r("/datanotes/operations/select_rows/"))).not.toContain("422");
    expect(Object.keys(r("/datanotes/operations/select_rows/"))).not.toContain("503");
    expect(Object.keys(r("/datanotes/operations/undo_migration/"))).not.toContain("503");
    // a read may answer 403 (a table outside the token's `read` patterns), with its own description; the owner's routes too
    expect(Object.keys(r("/datanotes/operations/select_rows/"))).toEqual(["200", "400", "401", "403", "404", "409", "500"]);
    expect((r("/datanotes/operations/select_rows/")["403"] as { description: string }).description).toContain("`read` patterns");
    expect((r("/datanotes/operations/insert_row/")["403"] as { description: string }).description).not.toContain("`read` patterns");
    expect(Object.keys(r("/datanotes/tokens/create/"))).toContain("403");
    // read patterns: on every entry, on create, and nullable on update
    expect(doc.components.schemas.Token).toMatchObject({ required: expect.arrayContaining(["read", "write"]), properties: { read: { type: "array", items: { type: "string" } } } });
    const body = (p: string) => ((doc.paths[p]!.post! as { requestBody?: unknown }).requestBody as { content: { "application/json": { schema: { properties: Record<string, unknown> } } } }).content["application/json"].schema.properties;
    expect(body("/datanotes/tokens/create/").read).toMatchObject({ type: "array", items: { type: "string" } });
    expect(body("/datanotes/tokens/update/").read).toMatchObject({ type: ["array", "null"], items: { type: "string" } });
    expect(Object.keys(r("/datanotes/operations/list_tables/"))).not.toContain("404");
    expect(r("/datanotes/operations/list_tables/")["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
    expect(doc.components.schemas.Error).toMatchObject({ required: ["error"], properties: { error: { type: "string" } } });
  });

  it("documents the extension registry: any token lists, only the owner records and deletes", () => {
    const r = (p: string) => doc.paths[p]!.post!;
    for (const p of ["/datanotes/extensions/", "/datanotes/extensions/record/", "/datanotes/extensions/delete/"]) {
      expect(r(p), p).toBeDefined();
      expect(r(p).tags, p).toEqual(["extensions"]);
    }
    expect(Object.keys(r("/datanotes/extensions/").responses)).not.toContain("403");
    expect(Object.keys(r("/datanotes/extensions/record/").responses)).toContain("403");
    expect(Object.keys(r("/datanotes/extensions/delete/").responses)).toContain("403");
    expect(doc.components.schemas.InstalledExtension).toMatchObject({ required: expect.arrayContaining(["name", "tables", "token"]) });
  });

  it("requires exactly the record fields the registry checks (R1-3)", () => {
    const schema = doc.components.schemas.InstalledExtension as { required: string[]; properties: Record<string, unknown> };
    const record: Record<string, unknown> = {
      name: "books",
      version: "0.1.0",
      description: "A reading list",
      api: 1,
      source: { kind: "local", path: "/x/books" },
      commit: "local-0123456789ab",
      manifest_sha256: "a".repeat(64),
      entry_sha256: "b".repeat(64),
      token: "ext-books",
      tables: { book: { table: "work.books.book", owned: true } },
      tools: ["list_reading"],
      write: ["work.books.book"],
      migration_id: null,
      installed_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
      previous: null,
    };
    expect(recordProblems(record)).toEqual([]);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(record).sort());
    for (const key of Object.keys(record)) {
      const without = { ...record };
      delete without[key];
      // a field the registry refuses to miss is required in the document, and only those
      expect(schema.required.includes(key), key).toBe(recordProblems(without).length > 0);
    }
  });

  it("uses each operation's responseSchema and hoists titled schemas into components", () => {
    const withSchema = OPERATIONS.find((t) => (t as { responseSchema?: Record<string, unknown> }).responseSchema && t.name === "insert_row");
    if (!withSchema) return; // the catalogue does not describe results yet
    const ok = doc.paths["/datanotes/operations/insert_row/"]!.post!.responses["200"] as { content: { "application/json": { schema: Record<string, unknown> } } };
    const schema = ok.content["application/json"].schema;
    const title = (withSchema as { responseSchema?: { title?: string } }).responseSchema!.title;
    if (title) expect(schema).toEqual({ $ref: `#/components/schemas/${title.replace(/[^A-Za-z0-9._-]+/g, "_")}` });
    else expect(schema).toBeDefined();
  });

  it("the catalogue gives each title one shape: a component is never another schema's", () => {
    const shapes = new Map<string, Set<string>>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      const s = v as Record<string, unknown>;
      if (typeof s.title === "string") {
        if (!shapes.has(s.title)) shapes.set(s.title, new Set());
        shapes.get(s.title)!.add(JSON.stringify(s));
      }
      for (const x of Object.values(s)) walk(x);
    };
    for (const o of OPERATIONS) walk((o as { responseSchema?: unknown }).responseSchema);
    expect([...shapes].filter(([, s]) => s.size > 1).map(([t]) => t)).toEqual([]);
    // check_table's rows name their table: a component of their own
    expect(doc.components.schemas.CheckedRow).toMatchObject({ properties: { table: { type: "string" } } });
  });

  it("hoists titled schemas once per title", async () => {
    const catalog = await import("../src/api/catalog");
    const a = catalog.OPERATIONS.find((t) => t.name === "insert_row") as { responseSchema?: unknown };
    const b = catalog.OPERATIONS.find((t) => t.name === "delete_rows") as { responseSchema?: unknown };
    const saved = [a.responseSchema, b.responseSchema];
    const shared = { title: "Shared Result", type: "object", properties: { ok: { type: "boolean" }, nested: { title: "Inner", type: "object", default: { title: "not a schema" } } } };
    a.responseSchema = shared;
    b.responseSchema = { ...shared };
    try {
      const d = openApiDocument("x") as unknown as Doc;
      const schemaOf = (p: string) => ((d.paths[p]!.post!.responses["200"] as { content: { "application/json": { schema: unknown } } }).content["application/json"].schema);
      expect(schemaOf("/datanotes/operations/insert_row/")).toEqual({ $ref: "#/components/schemas/Shared_Result" });
      expect(schemaOf("/datanotes/operations/delete_rows/")).toEqual({ $ref: "#/components/schemas/Shared_Result" });
      expect(d.components.schemas.Shared_Result).toMatchObject({ properties: { nested: { $ref: "#/components/schemas/Inner" } } });
      expect(d.components.schemas.Inner).toMatchObject({ default: { title: "not a schema" } });
      // a refused insert answers the same result
      expect((d.paths["/datanotes/operations/insert_row/"]!.post!.responses["422"] as { content: { "application/json": { schema: unknown } } }).content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Shared_Result" });
    } finally {
      [a.responseSchema, b.responseSchema] = saved;
    }
  });

  it("describes the routes beyond the catalogue", () => {
    const want: [string, string][] = [
      ["/", "get"],
      ["/datanotes/sessions/identify/", "post"],
      ["/datanotes/openapi.json", "get"],
      ["/datanotes/changes/stream", "get"],
      ["/datanotes/docs", "get"],
      ["/datanotes/manual/", "get"],
      ["/datanotes/manual/{page}.md", "get"],
      ["/datanotes/tool-calls/record/", "post"],
      ["/datanotes/operations/sync_semantic_index/", "post"],
      ["/datanotes/manual/search/", "post"],
      ["/datanotes/status/", "post"],
    ];
    for (const [p, m] of want) expect(doc.paths[p]?.[m], `${m} ${p}`).toBeDefined();
    // the docs ranked by meaning (hybrid search_docs): any token reads them; 503 without the docs
    const docsSearch = doc.paths["/datanotes/manual/search/"]!.post!;
    expect([docsSearch.operationId, docsSearch.tags]).toEqual(["semantic_search_docs", ["service"]]);
    expect(Object.keys(docsSearch.responses)).toEqual(["200", "400", "401", "500", "503"]);
    expect(doc.components.schemas.DocsSemanticResults).toMatchObject({ required: ["query", "version", "ready", "sections", "embedded", "results"] });
    // gone: the Local REST API routes (read_note, list_folder and search_notes read the vault)
    for (const p of ["/datanotes/api/", "/datanotes/views/render/", "/vault/", "/vault/{path}", "/vault/{folder}/", "/search/simple/"]) expect(doc.paths[p], p).toBeUndefined();
    for (const p of ["/", "/datanotes/openapi.json", "/datanotes/docs"]) expect(doc.paths[p]!.get!.security).toEqual([]);
    expect((doc.paths["/datanotes/operations/insert_row/"]!.post as { parameters?: unknown[] }).parameters).toEqual([{ $ref: "#/components/parameters/Actor" }]);
    expect(doc.components.parameters.Actor).toMatchObject({ name: "X-Datanotes-Actor", in: "header", required: false });
    // the engine's status: owner only (an app's token answers 403), its report in components
    const st = doc.paths["/datanotes/status/"]!.post!;
    expect(st.tags).toEqual(["service"]);
    expect(Object.keys(st.responses)).toEqual(["200", "400", "401", "403", "500"]);
    expect(st.responses["200"]).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/EngineStatus" } } } });
    expect(doc.components.schemas.EngineStatus).toMatchObject({ required: ["healthy", "problems", "engine", "database", "git_sync", "store_backup", "change_feed", "webhooks", "tokens", "hand_edits", "logs"] });
  });

  it("documents every route the running engine serves", async () => {
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-"));
    fs.mkdirSync(path.join(root, "Datanotes"), { recursive: true });
    fs.writeFileSync(path.join(root, METASTORE), withTables("task:\n  columns:\n    - { name: title, type: string }\n"));
    seedStoreSettings(root, { httpServerPort: port, httpServerToken: "owner-token", fileLogEnabled: false, autoRecompute: false }, METASTORE);
    const svc: RunningService = await startService({ vault: root, watch: "poll", pollMs: 200 }, {});
    try {
      const missing = Object.keys(svc.runtime.handlers())
        .filter((route) => route !== "/openapi.json/") // served as GET /datanotes/openapi.json
        .filter((route) => !doc.paths[`/datanotes${route}`]);
      expect(missing).toEqual([]);
    } finally {
      await svc.stop();
    }
  });
});

describe("public spec and docs console", () => {
  let server: HttpApiServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start() {
    const v = logVault({});
    const token = newToken();
    server = new HttpApiServer({ app: v.app, handlers: createHandlers(v.app, () => v.settings), token, port: 0, version: "9.9.9" });
    const base = `http://127.0.0.1:${await server.start()}`;
    return { base, token };
  }

  it("serves the spec and the docs without a token, and nothing else", async () => {
    const { base, token } = await start();
    const spec = await fetch(`${base}/datanotes/openapi.json`);
    expect(spec.status).toBe(200);
    expect(spec.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await spec.json()) as Doc;
    expect(body.servers).toEqual([{ url: "/" }]);
    expect((await fetch(`${base}/datanotes/openapi.json`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

    for (const p of ["/datanotes/docs", "/datanotes/docs/"]) {
      const page = await fetch(`${base}${p}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/^text\/html/);
      expect(page.headers.get("content-security-policy")).toBe(DOCS_CSP);
      expect(DOCS_CSP).toMatch(/default-src 'self'/);
      expect(DOCS_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
      const html = await page.text();
      expect(html).toContain("<title>Datanotes API</title>");
      // only same-origin assets, no inline script or style
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((u) => u !== "data:,"); // the empty favicon
      expect(urls.length).toBe(3);
      for (const u of urls) expect(u).toMatch(/^\/datanotes\/docs\/[\w.-]+\.(css|js)\?v=9\.9\.9$/);
      expect(html).not.toMatch(/<script>|<style|style="/);
      expect(html).not.toMatch(/https?:\/\//);
    }

    const css = await fetch(`${base}/datanotes/docs/swagger-ui.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect((await css.text()).length).toBeGreaterThan(10_000);
    const js = await fetch(`${base}/datanotes/docs/swagger-ui-bundle.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    const code = await js.text();
    expect(code).toContain("SwaggerUIBundle");
    expect(code).not.toMatch(/sourceMappingURL=\S+\s*$/);
    const init = await (await fetch(`${base}/datanotes/docs/init.js`)).text();
    expect(init).toContain('url: "/datanotes/openapi.json"');
    expect(init).toContain("persistAuthorization: true");
    expect(init).toContain("tryItOutEnabled: true");
    expect(init).toContain("validatorUrl: null");

    // everything else still needs the token
    expect((await fetch(`${base}/datanotes/operations/list_tables/`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/datanotes/openapi/`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/datanotes/docs/other.js`)).status).toBe(401);
    expect((await fetch(`${base}/vault/`)).status).toBe(401);
    expect((await fetch(`${base}/datanotes/docs`, { method: "POST" })).status).toBe(401);
  });
});
