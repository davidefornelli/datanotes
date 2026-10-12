/**
 * The naming guide of Datanotes 3 (CONTRIBUTING.md, "Names"), checked on every operation of the
 * catalogue: its name, its arguments, its answer fields and the values of its enums.
 */

import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";

type Schema = Record<string, any>;

/** Every property of a schema, nested ones too: `[where, name, schema]`. */
function properties(s: Schema, where: string): [string, string, Schema][] {
  const out: [string, string, Schema][] = [];
  const walk = (x: Schema, at: string): void => {
    for (const b of x.anyOf ?? x.oneOf ?? []) walk(b, at);
    if (x.items) walk(x.items, `${at}[]`);
    for (const [name, sub] of Object.entries((x.properties ?? {}) as Record<string, Schema>)) {
      out.push([at, name, sub]);
      walk(sub, `${at}.${name}`);
    }
  };
  walk(s, where);
  return out;
}

/** The string values of a schema's enums (its own, its branches', its items'). */
function enumValues(s: Schema): unknown[] {
  return [...(s.enum ?? []), ...(s.anyOf ?? s.oneOf ?? []).flatMap(enumValues), ...(s.items ? enumValues(s.items) : [])];
}

const ARGS = OPERATIONS.flatMap((o) => properties(o.inputSchema as Schema, o.name));
const ANSWERS = OPERATIONS.flatMap((o) => properties((o.responseSchema ?? {}) as Schema, o.name));
const ALL = [...ARGS, ...ANSWERS];
const where = ([at, name]: [string, string, Schema]) => `${at}.${name}`;

/** Reserved words of Python and JavaScript: an argument by such a name is awkward in both. */
const RESERVED = new Set(
  "and as assert async await break case catch class const continue debugger def default del delete do elif else enum except export extends false finally for from function global if import in instanceof is lambda let new nonlocal none not null or pass private protected public raise return static super switch this throw true try typeof var void while with yield".split(" "),
);

describe("the naming guide", () => {
  it("operations, arguments and answer fields are snake_case", () => {
    const snake = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
    expect(OPERATIONS.map((o) => o.name).filter((n) => !snake.test(n))).toEqual([]);
    expect(ARGS.filter(([, n]) => !snake.test(n)).map(where)).toEqual([]);
    // a field the engine adds to a row, beside the row's own columns, starts with _ (`_change_type`)
    expect(ANSWERS.filter(([, n]) => !snake.test(n.replace(/^_/, ""))).map(where)).toEqual([]);
  });

  it("no argument is a reserved word of Python or JavaScript", () => {
    expect(ARGS.filter(([, n]) => RESERVED.has(n)).map(where)).toEqual([]);
  });

  it("rows and tables are always lists; a count says so in its name", () => {
    const notList = ALL.filter(([, n, s]) => (n === "rows" || n === "tables") && !(s.type === "array" || (s.anyOf ?? []).some((b: Schema) => b.type === "array")));
    expect(notList.map(where)).toEqual([]);
  });

  it("an explanation is a description, never a comment", () => {
    expect(ALL.filter(([, n]) => n === "comment" || n.endsWith("_comment")).map(where)).toEqual([]);
  });

  it("a folder is a folder, never a directory", () => {
    expect(OPERATIONS.map((o) => o.name).filter((n) => n.includes("directory"))).toEqual([]);
    expect(ALL.filter(([, n]) => n.includes("directory")).map(where)).toEqual([]);
  });

  it("a duration has its unit in its name", () => {
    const duration = /(timeout|interval|delay|ttl|retention|wait)/;
    const unit = /_(ms|s|min|hours|days)$/;
    expect(ALL.filter(([, n, s]) => duration.test(n) && (s.type === "number" || s.type === "integer") && !unit.test(n)).map(where)).toEqual([]);
  });

  it("enum values are snake_case, and following the default is \"default\", never \"inherit\"", () => {
    const value = /^[a-z0-9]+(_[a-z0-9]+)*$/;
    const bad = ALL.flatMap(([at, n, s]) => enumValues(s).filter((v) => typeof v === "string" && !value.test(v)).map((v) => `${at}.${n} = ${JSON.stringify(v)}`));
    expect(bad).toEqual([]);
    expect(ALL.filter(([, , s]) => enumValues(s).includes("inherit")).map(where)).toEqual([]);
  });
});
