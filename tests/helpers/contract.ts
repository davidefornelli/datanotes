/**
 * The public contract of Datanotes 3 as lines of text (`contract/datanotes-3.txt`, checked by
 * tests/contract.test.ts): the operations with their arguments and answer fields, the HTTP routes,
 * the commands and their options, the environment variables, the settings and the violation codes.
 *
 * A change that keeps every program working only adds lines: a new operation, argument, field,
 * enum value or type of an argument. A change that breaks one removes a line, and a line never
 * goes (docs: /reference/compatibility/).
 */

import fs from "node:fs";
import path from "node:path";
import { OPERATIONS } from "../../src/api/catalog";
import { STORE_OPTIONS } from "../../src/node/store-command";
import type { OptionSpec } from "../../src/api/cli-options";
import { DEFAULT_SETTINGS } from "../../src/core/settings";
import { VIOLATION_GUIDANCE } from "../../src/core/hints";
import { help } from "../../src/node/help";
import { SERVE_OPTIONS as MCP_SERVE_OPTIONS, STDIO_OPTIONS } from "../../src/mcp/command";
import { SERVE_OPTIONS } from "../../src/node/service";
import { STATUS_OPTIONS } from "../../src/node/status";
import { STOP_OPTIONS } from "../../src/node/stop";
import { openApiDocument } from "../../src/server/openapi";

type Schema = Record<string, any>;

/** The members of a schema's type: one line each, so a widened type only adds lines. */
function typesOf(s: Schema): string[] {
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).flatMap(typesOf))] as string[];
  if (s.type === "array") return typesOf(s.items ?? {}).map((t) => `${t}[]`);
  if (Array.isArray(s.type)) return s.type as string[];
  return [s.type ?? (s.properties ? "object" : "any")];
}

/** The fields of a schema, nested ones as `a.b`, the items of a list as `a[].b`, and the values of its enums. */
function fieldsOf(s: Schema, prefix: string, out: Map<string, string[]>): void {
  const enumOf = (x: Schema): unknown[] => [...(x.enum ?? []), ...(x.anyOf ?? x.oneOf ?? []).flatMap(enumOf), ...(x.items ? enumOf(x.items) : [])];
  const walk = (x: Schema, at: string): void => {
    for (const branch of x.anyOf ?? x.oneOf ?? []) walk(branch, at);
    if (x.items) walk(x.items, `${at}[]`);
    for (const [name, sub] of Object.entries((x.properties ?? {}) as Record<string, Schema>)) {
      const key = at ? `${at}.${name}` : name;
      const lines = out.get(key) ?? [];
      lines.push(...typesOf(sub).map((t) => `: ${t}`), ...enumOf(sub).map((v) => ` = ${JSON.stringify(v)}`));
      out.set(key, lines);
      walk(sub, key);
    }
  };
  walk(s, prefix);
}

/** The `DATANOTES_*` environment variables the source names, sorted. */
export function environmentVariables(): string[] {
  const src = path.join(__dirname, "..", "..", "src");
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) for (const v of fs.readFileSync(p, "utf8").match(/\bDATANOTES_[A-Z0-9_]+/g) ?? []) found.add(v);
    }
  };
  walk(src);
  return [...found].sort();
}

/** The `datanotes --help` text, with the options of `datanotes mcp`. */
export const helpText = (): string => help("3");

function optionLines(command: string, spec: OptionSpec): string[] {
  return [...(spec.values ?? []).map((o) => `command ${command} --${o} <value>`), ...(spec.flags ?? []).map((o) => `command ${command} --${o}`)];
}

/** Every line of the contract, sorted. */
export function contractLines(): string[] {
  const lines: string[] = [];
  const add = (line: string) => lines.push(line);
  for (const op of OPERATIONS) {
    add(`operation ${op.name}`);
    const input = op.inputSchema as Schema;
    const required = new Set((input.required ?? []) as string[]);
    for (const name of Object.keys(input.properties ?? {})) if (!required.has(name)) add(`argument ${op.name}.${name} optional`);
    const args = new Map<string, string[]>();
    fieldsOf(input, "", args);
    for (const [k, v] of args) for (const t of new Set(v)) add(`argument ${op.name}.${k}${t}`);
    const answer = new Map<string, string[]>();
    fieldsOf((op.responseSchema ?? {}) as Schema, "", answer);
    for (const [k, v] of answer) for (const t of new Set(v)) add(`answer ${op.name}.${k}${t}`);
  }
  const paths = openApiDocument("3").paths as Record<string, Record<string, unknown>>;
  for (const [route, methods] of Object.entries(paths)) for (const m of Object.keys(methods)) add(`route ${m.toUpperCase()} ${route}`);
  const commands: [string, OptionSpec][] = [
    ["serve", SERVE_OPTIONS],
    ["status", STATUS_OPTIONS],
    ["stop", STOP_OPTIONS],
    ...Object.entries(STORE_OPTIONS).map(([sub, spec]) => [`store ${sub}`, spec] as [string, OptionSpec]),
    ["mcp", STDIO_OPTIONS],
    ["mcp serve", MCP_SERVE_OPTIONS],
  ];
  for (const [command, spec] of commands) for (const l of optionLines(command, spec)) add(l);
  for (const v of environmentVariables()) add(`environment ${v}`);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) add(`setting ${k}: ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}`);
  for (const code of Object.keys(VIOLATION_GUIDANCE)) add(`violation ${code}`);
  return [...new Set(lines)].sort();
}
