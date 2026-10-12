import { describe, expect, it } from "vitest";
import { hasThisTokens, resolveThisTokens, type Host } from "../src/core/this-tokens";

/** A daily note, with the frontmatter given. */
const day = (frontmatter: Record<string, unknown>): Host => ({ path: "Journal/2026-10-06.md", frontmatter });

describe("{this.*} tokens: values the note does not have", () => {
  it("a dotted field through a value that is not an object stays as written", () => {
    const host = day({ author: "Ursula", editor: null, review: { by: { name: "Ted" } } });
    expect(
      resolveThisTokens({ a: "{this.author.name}", b: "{this.editor.name}", c: "{this.nothing.at.all}", d: "{this.review.by.name}" }, host),
    ).toEqual({ a: "{this.author.name}", b: "{this.editor.name}", c: "{this.nothing.at.all}", d: "Ted" });
  });

  it("inside text a token without a value stays as written, the others become text", () => {
    const host = day({ owner: null, pages: 320, done: false });
    expect(resolveThisTokens("[[{this.nothing}]] by {this.owner} on {this.date}", host)).toBe("[[{this.nothing}]] by {this.owner} on {this.date}");
    expect(resolveThisTokens("{this.pages} pages, done: {this.done}, in [[{this.name}]]", host)).toBe("320 pages, done: false, in [[2026-10-06]]");
  });

  it("a whole-value token keeps the value's type: numbers, booleans, lists", () => {
    const host = day({ pages: 320, done: false, tags: ["sci-fi", "classic"] });
    expect(resolveThisTokens({ where: { pages: { gte: "{this.pages}" }, done: "{this.done}", tags: { in: "{this.tags}" } } }, host)).toEqual({
      where: { pages: { gte: 320 }, done: false, tags: { in: ["sci-fi", "classic"] } },
    });
  });
});

describe("{this.*} date arithmetic", () => {
  it("shifts a date or date-time value by days or weeks, across months and years", () => {
    const host = day({ date: "2026-12-31", at: "2026-03-01T21:30:00+01:00" });
    expect(resolveThisTokens(["{this.date+1d}", "{this.date-2w}", "{this.at-1d}", "{this.at+1w}"], host)).toEqual([
      "2027-01-01",
      "2026-12-17",
      "2026-02-28",
      "2026-03-08",
    ]);
  });

  it("shifts a Date value (a host that parses dates) by its UTC day", () => {
    const host = day({ date: new Date("2026-10-06T00:00:00Z") });
    expect(resolveThisTokens({ gte: "{this.date-1d}", lt: "{this.date+1w}" }, host)).toEqual({ gte: "2026-10-05", lt: "2026-10-13" });
  });

  it("a value that is not a date is kept as it is", () => {
    const host = day({ title: "Dune", pages: 320, done: true });
    expect(resolveThisTokens(["{this.title+1d}", "{this.pages+2d}", "{this.done-1w}"], host)).toEqual(["Dune", 320, true]);
  });

  it("is for whole-value tokens only: inside text a shifted token stays as written", () => {
    expect(resolveThisTokens("from {this.date+1d}", day({ date: "2026-10-06" }))).toBe("from {this.date+1d}");
  });
});

describe("hasThisTokens", () => {
  it.each([
    [undefined, false],
    [null, false],
    [{ where: { day: "{today}" } }, false],
    ["{this.date}", true],
    [{ where: { book: { in: ["[[Dune]]", "{this.link}"] } } }, true],
  ])("%j → %s", (query, expected) => {
    expect(hasThisTokens(query)).toBe(expected);
  });
});
