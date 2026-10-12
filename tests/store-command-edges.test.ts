/**
 * `datanotes store` (src/node/store-command.ts) at its edges: no command, the process's own
 * environment and output, a store without an id, `new-id` on a database folder (`--database`)
 * with its own store, settings that are not an object, and a restore whose clone fails or whose
 * repository cannot be prepared afterwards. Git is played by the test where a real one cannot fail.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metastoreId } from "../src/core/database-id";
import { gitSubcommand, type GitRunner } from "../src/node/git-sync";
import { main as storeCommand } from "../src/node/store-command";

const ID = "01a1b2c3-0000-7000-8000-0000000000c1";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "store-command-edges-"));
function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("datanotes store: the command line", () => {
  it("no command at all is refused, naming the commands", async () => {
    await expect(storeCommand([])).rejects.toThrow('unknown store command "": datanotes store path | new-id | backup | restore');
  });

  it("path: the process's environment and standard output by default; a store without an id says so", async () => {
    const vault = tmp();
    const store = tmp();
    write(store, "store.json", JSON.stringify({ vault }));
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((t) => {
      out += String(t);
      return true;
    });
    expect(await storeCommand(["path", "--vault", vault, "--store", store])).toBe(0);
    expect(out).toContain(`store      ${path.resolve(store)}\n`);
    expect(out).toContain("(id unknown)");
  });

  it("path --json for a vault without a store: every field null", async () => {
    const vault = tmp();
    let out = "";
    expect(await storeCommand(["path", "--vault", vault, "--json"], { env: { DATANOTES_DATA_HOME: tmp() }, write: (t) => (out += t) })).toBe(2);
    expect(JSON.parse(out)).toEqual({ vault: path.resolve(vault), store: null, database_id: null, database_folder: null });
  });

  it("new-id on a database folder (--database) with its own --store: dot-folders left out", async () => {
    const db = tmp();
    const store = tmp();
    const home = tmp();
    write(db, "metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    write(db, ".obsidian/workspace.json", "{}");
    let out = "";
    expect(await storeCommand(["new-id", "--database", db, "--store", store], { env: { DATANOTES_DATA_HOME: home }, write: (t) => (out += t) })).toBe(0);
    const id = metastoreId(fs.readFileSync(path.join(db, "metastore.yaml"), "utf8"));
    expect(id).not.toBe(ID);
    expect(out).toContain(`has the new id ${id} (was ${ID})`);
    expect(out).toContain(`store      ${path.resolve(store)} (new and empty`);
  });
});

describe("datanotes store backup: what it shows", () => {
  it("settings that are not an object count as none; an enabled backup shows on", async () => {
    const vault = tmp();
    const store = tmp();
    write(store, "store.json", JSON.stringify({ id: ID, vault, database: "datanotes" }));
    write(store, "settings.json", "[true]");
    let out = "";
    const io = { env: {}, write: (t: string) => void (out += t) };
    expect(await storeCommand(["backup", "--vault", vault, "--store", store], io)).toBe(0);
    expect(out).toMatch(/^store backup off\n/);
    write(store, "settings.json", JSON.stringify({ storeBackupEnabled: true, storeBackupRemote: "https://me:pw@example.com/s.git" }));
    out = "";
    expect(await storeCommand(["backup", "--vault", vault, "--store", store], io)).toBe(0);
    expect(out).toMatch(/^store backup on\nstore {8}.*\nremote {7}https:\/\/example\.com\/s\.git\n/);
  });
});

describe("datanotes store restore: git failing", () => {
  function vaultWithDatabase() {
    const vault = tmp();
    write(vault, "datanotes/metastore.yaml", `id: ${ID}\ncatalogs: {}\n`);
    write(vault, ".obsidian/app.json", "{}");
    return vault;
  }

  it("a clone that fails saying it on stdout only", async () => {
    const run: GitRunner = async () => ({ code: 128, stdout: "repository not found", stderr: "" });
    await expect(storeCommand(["restore", "--from", "https://example.com/s.git", "--vault", vaultWithDatabase()], { env: { DATANOTES_DATA_HOME: tmp() }, run, write: () => undefined })).rejects.toThrow(
      "git clone https://example.com/s.git failed: repository not found",
    );
  });

  it("a repository that cannot be prepared after the clone: restored, with a warning", async () => {
    const run: GitRunner = async (args) => {
      const sub = gitSubcommand(args);
      if (sub === "clone") fs.mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
      if (sub === "rev-parse") return { code: 1, stdout: "", stderr: "" };
      if (sub === "log") return { code: 0, stdout: `abc1234 2026-10-01T10:00:00Z\nstore backup: 1 file changed\n\nDatabase-Id: ${ID}\n`, stderr: "" };
      if (sub === "remote" && args.includes("get-url")) return { code: 2, stdout: "", stderr: "" };
      if (sub === "remote") return { code: 1, stdout: "", stderr: "error: could not lock config file" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const home = tmp();
    let out = "";
    expect(await storeCommand(["restore", "--from", "https://example.com/s.git", "--vault", vaultWithDatabase()], { env: { DATANOTES_DATA_HOME: home }, run, write: (t) => (out += t) })).toBe(0);
    expect(out).toContain("datanotes store: warning: git remote add: error: could not lock config file\n");
    expect(out).toContain("datanotes store: restored https://example.com/s.git (commit abc1234 2026-10-01T10:00:00Z)");
    expect(fs.existsSync(path.join(home, ID, "settings.json"))).toBe(true);
  });
});
