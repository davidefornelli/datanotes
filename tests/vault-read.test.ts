import { describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { listFolder, readNote, searchNotes, VaultPathError, VaultPathNotFoundError } from "../src/core/vault-read";
import { docsUrl } from "../src/core/hints";
import { logVault } from "./helpers/db-vault";

const NOTE = "---\ntags: [trip]\n---\nA dinner in Paris with Alice. #memory\n";

describe("read_note", () => {
  it("answers the text, the front matter, the tags of both and the file's times and size", async () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    const n = await readNote(v.app, v.settings, "/Notes/Café.md");
    expect(n).toMatchObject({ path: "Notes/Café.md", content: NOTE, front_matter: { tags: ["trip"] }, size: Buffer.byteLength(NOTE) });
    // the front matter's tags, and the text's where the host reads them (the Node host does)
    expect(n.tags).toContain("trip");
    expect(n.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+0[12]:00$/);
    expect(n.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a folder, an empty path and a missing file, saying what to call instead", async () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    await expect(readNote(v.app, v.settings, "Notes")).rejects.toThrow(new VaultPathError("Notes is a folder: list_folder lists it"));
    await expect(readNote(v.app, v.settings, "Notes/")).rejects.toBeInstanceOf(VaultPathError);
    await expect(readNote(v.app, v.settings, "")).rejects.toThrow("path must name a file, not a folder");
    const missing = await readNote(v.app, v.settings, "Notes/Nope.md").catch((e: unknown) => e as VaultPathNotFoundError);
    expect(missing).toBeInstanceOf(VaultPathNotFoundError);
    expect(missing).toMatchObject({ message: "no file Notes/Nope.md in the vault", docs: docsUrl("readNote") });
  });

  it("a host that gives no file stats answers null times and size", async () => {
    const v = logVault({ "Notes/Trip.md": "Trip\n" });
    const real = v.app.vault.getAbstractFileByPath.bind(v.app.vault);
    // the host's own vault (its methods live on its prototype), but a file without stats
    const vault = Object.assign(Object.create(v.app.vault) as object, { getAbstractFileByPath: (p: string) => (p === "Notes/Trip.md" ? { path: p, name: "Trip.md", basename: "Trip", extension: "md" } : real(p)) });
    const app = { ...v.app, vault };
    expect(await readNote(app as never, v.settings, "Notes/Trip.md")).toEqual({ path: "Notes/Trip.md", content: "Trip\n", front_matter: {}, tags: [], modified_at: null, created_at: null, size: null });
  });
});

describe("list_folder", () => {
  it("answers the sub-folders and the files as vault paths, leaving out dot-files and dot-folders", () => {
    const v = logVault({ "Notes/Café.md": NOTE, "Notes/Trips/Rome.md": "Rome\n", "Notes/.hidden.md": "x\n", ".obsidian/app.json": "{}" });
    expect(listFolder(v.app, "Notes/")).toEqual({ folder: "Notes", folders: ["Notes/Trips"], files: ["Notes/Café.md"] });
    const root = listFolder(v.app, "");
    expect(root.folder).toBe("");
    expect(root.folders).toEqual(expect.arrayContaining(["Daily", "Notes"]));
    expect(root.folders).not.toContain(".obsidian");
  });

  it("refuses a file and a missing folder", () => {
    const v = logVault({ "Notes/Café.md": NOTE });
    expect(() => listFolder(v.app, "Notes/Café.md")).toThrow(new VaultPathError("Notes/Café.md is a file: read_note reads it"));
    expect(() => listFolder(v.app, "Nope")).toThrow(new VaultPathNotFoundError("no folder Nope in the vault"));
  });
});

describe("search_notes", () => {
  it("counts every note that matches in total, and answers at most 200, best first", async () => {
    const notes = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`Many/Note ${String(i).padStart(3, "0")}.md`, `paris${i % 2 === 0 ? " paris" : ""}\n`]));
    const v = logVault(notes);
    const r = await searchNotes(v.app, "paris", 2);
    expect(r.total).toBe(205);
    expect(r.results).toHaveLength(200);
    expect(r.results[0]).toMatchObject({ path: "Many/Note 000.md", score: 2 });
    expect(r.results.at(-1)!.score).toBe(1);
  });

  it("leaves out notes in dot-folders, and clamps the context to 0..1000", async () => {
    const v = logVault({ "Notes/a.md": "Paris\n", ".trash/b.md": "Paris\n" });
    expect((await searchNotes(v.app, "paris")).results.map((r) => r.path)).toEqual(["Notes/a.md"]);
    expect((await searchNotes(v.app, "paris", -5)).results[0]!.matches[0]!.context).toBe("Paris\n");
    expect((await searchNotes(v.app, "paris", 5000)).results[0]!.matches[0]!.context).toBe("Paris\n");
  });
});
