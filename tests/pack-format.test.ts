import { describe, expect, it } from "vitest";
import { buildMarkdownWithFrontmatter, flowYamlValue, parseYamlValue } from "../src/core/frontmatter";
import { isPackFrontmatter, PackFormatError, packable, parsePack, rowNoteText, sectionText, writePack, type PackRow } from "../src/core/pack-format";

const TABLE = "family.babycare.milk_feed";

/** A row as the engine writes it: `table` first, then `id`. */
function row(heading: string, values: [string, unknown][], body = ""): PackRow {
  return { heading, ordered: [["table", TABLE], ["id", `id-${heading}`], ...values], body };
}

/** The row back from a pack holding it. */
function roundTrip(r: PackRow): PackRow {
  const [s] = parsePack(writePack({ table: TABLE, key: "2026-10" }, [r])).sections;
  return { heading: s!.heading, ordered: s!.ordered, body: s!.body };
}

describe("pack format: values", () => {
  const values: [string, unknown][] = [
    ["text", "a:: b # c | [[x]] and\na new line  "],
    ["trailing", "trail  "],
    ["leading", " lead"],
    ["empty", ""],
    ["looks_like_number", "007"],
    ["looks_like_bool", "true"],
    ["integer", 11],
    ["number", 1.5],
    ["negative", -3],
    ["boolean", false],
    ["null", null],
    ["date", "2026-10-23"],
    ["datetime", "2026-10-23T14:22:14+02:00"],
    ["enum", "left"],
    ["link", "[[Vittoria Fornelli]]"],
    ["link_alias", "[[people/Vittoria Fornelli|Vittoria]]"],
    ["links", ["[[A]]", "[[B|b]]"]],
    ["strings", ["a b", "c,d", "e]f", "g\nh"]],
    ["empty_list", []],
    ["json", { feeds: [{ side: "left", min: 5 }, { side: "right", min: 7, note: "x: y\nz" }], ok: true }],
    ["unicode", "caffè ☕  "],
  ];

  it("every value comes back the same from its section", () => {
    const r = row("2026-10-23T142214", values);
    expect(roundTrip(r)).toEqual(r);
  });

  for (const [name, v] of values) {
    it(`${name}: one line of YAML that reads back the same`, () => {
      const text = flowYamlValue(v);
      expect(text).not.toContain("\n");
      expect(parseYamlValue(text)).toEqual(v);
    });
  }

  it("a link is quoted, a date-time is plain", () => {
    expect(flowYamlValue("[[Vittoria Fornelli]]")).toBe('"[[Vittoria Fornelli]]"');
    expect(flowYamlValue("2026-10-23T14:22:14+02:00")).toBe("2026-10-23T14:22:14+02:00");
    expect(flowYamlValue(["[[A]]", "[[B]]"])).toBe('["[[A]]", "[[B]]"]');
  });

  it("the row's text comes back the same, line breaks of any kind included", () => {
    for (const body of ["", "\n", "Text", "Text\n", "\nText\n", "Line one\r\nLine two\r\n", "\r\nText", "Text\n\n\n", "### A heading\n\ntext\n", "```\n## inside code\n```\n"]) {
      const r = row("x", [["n", 1]], body);
      expect(roundTrip(r).body).toBe(body);
    }
  });

  it("rows whose texts do not end with a line break keep their texts in a pack of several", () => {
    const rows = [row("a", [["n", 1]], "first"), row("b", [["n", 2]], ""), row("c", [["n", 3]], "third\n"), row("d", [["n", 4]], "last")];
    const back = parsePack(writePack({ table: TABLE, key: "k" }, rows)).sections;
    expect(back.map((s) => [s.heading, s.ordered, s.body])).toEqual(rows.map((r) => [r.heading, r.ordered, r.body]));
  });
});

describe("pack format: packs", () => {
  it("a pack written and read again gives the same sections in the order of their headings", () => {
    const rows = [row("2026-10-23T142214", [["duration_min", 11]], "Free text.\n"), row("2026-10-01T080000", [["duration_min", 9]])];
    const text = writePack({ table: TABLE, key: "2026-10" }, rows);
    const p = parsePack(text);
    expect(p.meta).toEqual({ table: TABLE, key: "2026-10", description: expect.stringContaining("Rows of family.babycare.milk_feed for 2026-10") });
    expect(p.sections.map((s) => s.heading)).toEqual(["2026-10-01T080000", "2026-10-23T142214"]);
    expect(writePack(p.meta, p.sections)).toBe(text);
    // each section's text and offsets
    for (const s of p.sections) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
      expect(s.text).toBe(sectionText(s, TABLE));
      expect(text.split("\n")[s.line - 1]).toBe(`## ${s.heading}`);
    }
  });

  it("the format of the docs", () => {
    const text = writePack({ table: TABLE, key: "2026-10" }, [row("2026-10-23T142214", [["person", "[[Vittoria Fornelli]]"], ["started_at", "2026-10-23T14:22:14+02:00"], ["duration_min", 11]], "Testo libero.\n")]);
    expect(text).toBe(
      [
        "---",
        `pack: ${TABLE}`,
        "key: 2026-10",
        `description: "Rows of ${TABLE} for 2026-10. Each ## section is a row, its fields are key:: value. Read them with select_rows."`,
        "---",
        "",
        "## 2026-10-23T142214",
        "id:: id-2026-10-23T142214",
        'person:: "[[Vittoria Fornelli]]"',
        "started_at:: 2026-10-23T14:22:14+02:00",
        "duration_min:: 11",
        "",
        "Testo libero.",
        "",
      ].join("\n"),
    );
  });

  it("the table comes from the pack only when it is the row's first property, as written", () => {
    const short: PackRow = { heading: "a", ordered: [["id", "1"], ["table", "milk_feed"], ["n", 1]], body: "" };
    expect(sectionText(short, TABLE)).toContain("table:: milk_feed");
    expect(roundTrip(short)).toEqual(short);
    expect(sectionText(row("b", []), TABLE)).not.toContain("table::");
  });

  it("isPackFrontmatter: a pack names its table", () => {
    expect(isPackFrontmatter({ pack: TABLE })).toBe(true);
    expect(isPackFrontmatter({ pack: "" })).toBe(false);
    expect(isPackFrontmatter({ table: TABLE })).toBe(false);
    expect(isPackFrontmatter(undefined)).toBe(false);
  });

  it("a heading inside a code block is the row's text", () => {
    const text = "---\npack: t\nkey: k\n---\n\n## a\nid:: 1\n\n```\n## not a row\n```\n\n## b\nid:: 2\n";
    const p = parsePack(text);
    expect(p.sections.map((s) => s.heading)).toEqual(["a", "b"]);
    expect(p.sections[0]!.body).toBe("```\n## not a row\n```\n");
  });

  it("a pack saved with CRLF line endings still reads", () => {
    const text = writePack({ table: TABLE, key: "k" }, [row("a", [["n", 1]], "x\n"), row("b", [["n", 2]])]).replace(/\n/g, "\r\n");
    const p = parsePack(text);
    expect(p.sections.map((s) => [s.heading, new Map(s.ordered).get("n")])).toEqual([["a", 1], ["b", 2]]);
  });
});

describe("pack format: sections read before", () => {
  const rows = [row("a", [["n", 1]], "text\n"), row("b", [["n", 2]])];
  const text = writePack({ table: TABLE, key: "k" }, rows);

  it("a known section takes its values from `known`, its text from the pack", () => {
    const seen: string[] = [];
    const p = parsePack(text, "table", (t) => {
      seen.push(t);
      return t.startsWith("## a") ? [["table", TABLE], ["id", "id-a"], ["n", 100]] : undefined;
    });
    expect(seen).toHaveLength(2);
    expect(p.sections.map((s) => [s.heading, new Map(s.ordered).get("n"), s.body])).toEqual([["a", 100, "text\n"], ["b", 2, ""]]);
  });

  it("a known section without text, and one saved with CRLF (parsed again)", () => {
    const known = () => [["table", TABLE], ["id", "x"]] as [string, unknown][];
    expect(parsePack(writePack({ table: TABLE, key: "k" }, [row("a", [])]), "table", known).sections[0]!.body).toBe("");
    const crlf = parsePack(text.replace(/\n/g, "\r\n"), "table", known);
    expect(crlf.sections.map((s) => new Map(s.ordered).get("id"))).toEqual(["id-a", "id-b"]);
  });

  it("two known sections with one id are refused", () => {
    expect(() => parsePack(text, "table", () => [["id", "same"]])).toThrow(/two rows with the id same/);
  });

  it("a pack without rows, and rows given with one heading twice", () => {
    expect(parsePack("---\npack: t\nkey: k\n---\n").sections).toEqual([]);
    expect(() => parsePack(writePack({ table: TABLE, key: "k" }, [row("a", []), row("a", [])]))).toThrow(/two rows named "a"/);
  });
});

describe("pack format: errors name the line", () => {
  const head = "---\npack: t\nkey: k\n---\n";
  const fails = (text: string, line: number, what: RegExp) => {
    let err: unknown;
    try {
      parsePack(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PackFormatError);
    expect((err as PackFormatError).line).toBe(line);
    expect((err as Error).message).toMatch(what);
  };

  it("a section without id", () => fails(`${head}\n## a\nn:: 1\n`, 6, /has no id/));
  it("a field whose YAML does not parse", () => fails(`${head}\n## a\nid:: 1\nn:: [1, 2\n`, 8, /not YAML/));
  it("two sections with one heading", () => fails(`${head}\n## a\nid:: 1\n\n## a\nid:: 2\n`, 9, /two rows named "a"/));
  it("two sections with one id", () => fails(`${head}\n## a\nid:: 1\n\n## b\nid:: 1\n`, 9, /two rows with the id 1/));
  it("a line that is no field before the empty line", () => fails(`${head}\n## a\nid:: 1\ntext\n`, 8, /a field is "key:: value"/));
  it("text before the first row", () => fails(`${head}\nhello\n## a\nid:: 1\n`, 6, /text before the first row/));
  it("a field twice", () => fails(`${head}\n## a\nid:: 1\nid:: 2\n`, 8, /"id" twice/));
  it("no table, no key, broken front matter", () => {
    fails("---\nkey: k\n---\n", 1, /names its table/);
    fails("---\npack: t\n---\n", 1, /has a "key"/);
    fails("---\npack: [t\n---\n", 1, /cannot be read/);
  });
  it("an empty heading", () => fails(`${head}\n## \nid:: 1\n`, 6, /cannot be empty/));
});

describe("pack format: packable", () => {
  const note = (ordered: [string, unknown][], body = "") => buildMarkdownWithFrontmatter(ordered, body);
  const base: [string, unknown][] = [["table", TABLE], ["id", "1"], ["n", 1]];

  it("a note the engine wrote goes into a pack, and comes back byte for byte", () => {
    const text = note(base, "\nSome text.\n\n### A small heading\n");
    const r = packable(text, "2026-10-23T142214", TABLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rowNoteText(roundTrip(r.row))).toBe(text);
  });

  it("a note in another YAML style stays a note", () => {
    const r = packable("---\ntable: t\nid: '1'\n---\n", "a", TABLE);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/not what the engine writes/) });
  });

  it("a # or ## heading outside code keeps it out; inside code it does not", () => {
    expect(packable(note(base, "# Title\n"), "a", TABLE)).toMatchObject({ ok: false, reason: expect.stringMatching(/# or ## heading/) });
    expect(packable(note(base, "text\n## Part\n"), "a", TABLE)).toMatchObject({ ok: false });
    expect(packable(note(base, "Title\n===\n"), "a", TABLE)).toMatchObject({ ok: false });
    expect(packable(note(base, "```md\n# inside\n```\n"), "a", TABLE)).toMatchObject({ ok: true });
    expect(packable(note(base, "- item\n---\n"), "a", TABLE)).toMatchObject({ ok: true });
  });

  it("a name with %% or a character a heading link cannot hold stays a note", () => {
    for (const name of ["a %% b", "a#b", "a|b", "a^b", "a[b]", " a", ""]) expect(packable(note(base), name, TABLE)).toMatchObject({ ok: false });
  });

  it("a property a field line cannot hold stays a note", () => {
    expect(packable(note([...base, ["#hash", 1]]), "a", TABLE)).toMatchObject({ ok: false, reason: expect.stringMatching(/field line/) });
  });

  it("a note without front matter, or with broken front matter, stays a note", () => {
    expect(packable("just text\n", "a", TABLE)).toMatchObject({ ok: false, reason: "it has no front matter" });
    expect(packable("---\na: [\n---\n", "a", TABLE)).toMatchObject({ ok: false, reason: "its front matter cannot be read" });
  });

  it("a note without an id stays a note", () => {
    expect(packable(note([["table", TABLE], ["n", 1]]), "a", TABLE)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not read back/) });
  });
});
