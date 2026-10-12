// The HTTP API pages (starlight-openapi, under /api/) as Markdown, written from openapi.json (generated
// by scripts/gen-docs.mjs): the overview, one page per tag, one per operation. The document is read
// as written, with its `$ref`s: a schema shows by its name (`OpResult`), defined in openapi.json.
import document from "../../public/openapi.json";

/** One page of starlight-openapi (its libs/route.ts), the fields used here. */
export interface OpenAPIRoute {
  params: { openAPISlug: string };
  props:
    | { type: "schema-overview" }
    | { type: "operation-tag-overview"; tag: { name: string; description?: string } }
    | { type: "operation"; operation: { method: string; path?: string; title: string; slug: string; operation: { operationId?: string } } };
}

type Json = Record<string, any>;
const doc = document as Json;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** A `$ref` inside openapi.json, followed. */
function resolve(node: Json | undefined): Json | undefined {
  let seen = 0;
  while (node?.$ref && seen++ < 10) {
    node = (node.$ref as string)
      .replace(/^#\//, "")
      .split("/")
      .reduce((at: Json | undefined, key) => at?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  }
  return node;
}

/** A schema as a short type: `string`, `OpResult`, `string | null`, `{ path: string }[]`. */
function typeOf(schema: Json | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) return (schema.$ref as string).split("/").pop()!;
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) return alternatives.map(typeOf).join(" | ");
  if (schema.allOf) return schema.allOf.map(typeOf).join(" & ");
  if (schema.type === "array") {
    const item = typeOf(schema.items);
    return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "any";
}

/**
 * A description of openapi.json as Markdown text: a `<` that starts a tag (`table=<view>`) is escaped,
 * as written it would be HTML. Code (fenced or inline) and autolinks (`<https://…>`) stay as they are.
 */
function text(s: unknown): string {
  let fence: string | null = null;
  return String(s ?? "")
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === null && marker) fence = marker;
      else if (fence !== null && marker && line.trim() === marker) fence = null;
      else if (fence === null) return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part.replace(/<(?=[A-Za-z/!?])(?![a-z][a-z+.-]*:\/\/)/g, "\\<"))).join("");
      return line;
    })
    .join("\n");
}

const cell = (s: unknown) => text(s).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
const code = (s: string) => `\`${s}\``;
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

/** The site's address of each operation's page, by `METHOD path`. */
function operationPages(routes: OpenAPIRoute[], site: string) {
  const pages = new Map<string, { url: string; title: string }>();
  for (const route of routes) {
    if (route.props.type !== "operation") continue;
    const { method, path, title } = route.props.operation;
    pages.set(`${method} ${path}`, { url: `${site}/${route.params.openAPISlug}/`, title });
  }
  return pages;
}

/** The operations of one tag (or every tag), as a list of links. */
function operationList(pages: Map<string, { url: string; title: string }>, tag?: string): string[] {
  const lines: string[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {}) as [string, Json][]) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || (tag !== undefined && !(op.tags ?? []).includes(tag))) continue;
      const page = pages.get(`${method} ${path}`);
      if (page) lines.push(`- [${page.title}](${page.url}): ${code(`${method.toUpperCase()} ${path}`)}`);
    }
  }
  return lines;
}

function overview(routes: OpenAPIRoute[], site: string): string {
  const { info } = doc;
  const parts = [`# ${info.title} HTTP API`, `> OpenAPI ${doc.openapi} description of the ${info.title} ${info.version} HTTP API: ${site}/openapi.json`, text(info.description)];
  if (doc.servers?.length) parts.push("## Servers", doc.servers.map((s: Json) => `- ${code(s.url)}${s.description ? `: ${text(s.description)}` : ""}`).join("\n"));
  const schemes = Object.entries(doc.components?.securitySchemes ?? {}) as [string, Json][];
  if (schemes.length) {
    parts.push("## Authentication", schemes.map(([name, s]) => `- ${code(name)}: ${[s.type, s.scheme, s.in && `in ${s.in}`, s.name && code(s.name)].filter(Boolean).join(" ")}${s.description ? `. ${text(s.description)}` : ""}`).join("\n"));
  }
  const pages = operationPages(routes, site);
  parts.push("## Operations");
  for (const tag of doc.tags ?? []) {
    const list = operationList(pages, tag.name);
    if (list.length) parts.push(`### ${tag.name}`, ...(tag.description ? [text(tag.description)] : []), list.join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

function tagPage(tag: { name: string; description?: string }, routes: OpenAPIRoute[], site: string): string {
  return [`# ${tag.name}`, text(tag.description), "## Operations", operationList(operationPages(routes, site), tag.name).join("\n")].filter(Boolean).join("\n\n");
}

function operationPage(route: Extract<OpenAPIRoute["props"], { type: "operation" }>["operation"], site: string): string {
  const { method, path = "", title } = route;
  const item: Json = doc.paths?.[path] ?? {};
  const op: Json = item[method] ?? {};
  const parts = [`# ${title}`, `${code(`${method.toUpperCase()} ${path}`)}${op.operationId ? ` (operation ${code(op.operationId)})` : ""}`];
  if (op.description) parts.push(text(op.description));
  if (op.deprecated) parts.push("**Deprecated.**");
  if (Array.isArray(op.security) && op.security.length === 0) parts.push("No authentication needed.");

  const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve).filter(Boolean) as Json[];
  if (parameters.length) {
    parts.push("## Parameters", table(["Name", "In", "Type", "Required", "Description"], parameters.map((p) => [code(p.name), p.in, code(typeOf(p.schema)), p.required ? "yes" : "no", p.description ?? ""])));
  }

  const body = resolve(op.requestBody);
  if (body) {
    parts.push("## Request body");
    for (const [type, media] of Object.entries(body.content ?? {}) as [string, Json][]) {
      const schema = resolve(media.schema);
      parts.push(`${code(type)}${body.required ? ", required" : ""}${body.description ? `: ${text(body.description)}` : ""}`);
      if (schema?.properties) {
        const required = new Set<string>(schema.required ?? []);
        parts.push(
          table(
            ["Property", "Type", "Required", "Default", "Description"],
            Object.entries(schema.properties as Record<string, Json>).map(([name, s]) => [code(name), code(typeOf(s)), required.has(name) ? "yes" : "no", s.default === undefined ? "" : code(JSON.stringify(s.default)), s.description ?? ""]),
          ),
        );
      } else if (media.schema) {
        parts.push(`Type: ${code(typeOf(media.schema))}`);
      }
    }
  }

  const responses = Object.entries(op.responses ?? {}) as [string, Json][];
  if (responses.length) {
    parts.push(
      "## Responses",
      table(
        ["Status", "Description", "Body"],
        responses.map(([status, r]) => {
          const response = resolve(r) ?? {};
          const bodies = Object.entries(response.content ?? {}).map(([type, media]) => `${code(typeOf((media as Json).schema))} (${type})`);
          return [status, response.description ?? "", bodies.join(", ")];
        }),
      ),
    );
  }
  parts.push(`The schemas named here are in [openapi.json](${site}/openapi.json) (\`components.schemas\`).`);
  return parts.join("\n\n");
}

/** One page of the HTTP API reference as Markdown; `routes`: all its pages (getSchemaStaticPaths), for the links. */
export function openAPIPageToMarkdown(route: OpenAPIRoute, routes: OpenAPIRoute[], site: string): string {
  const { props } = route;
  if (props.type === "schema-overview") return overview(routes, site);
  if (props.type === "operation-tag-overview") return tagPage(props.tag, routes, site);
  return operationPage(props.operation, site);
}
