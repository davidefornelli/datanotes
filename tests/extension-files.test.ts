import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeDir, EXTENSIONS_FOLDER, extensionsHome, fileSha256, readTokenFile, removeTokenFile, sha256Hex, tokenPath, writeTokenFile } from "../src/api/extension-files";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-ext-files-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension files", () => {
  it("puts extensions under the data home", () => {
    expect(EXTENSIONS_FOLDER).toBe("extensions");
    expect(extensionsHome({ DATANOTES_DATA_HOME: tmp })).toBe(path.join(path.resolve(tmp), "extensions"));
    expect(typeof extensionsHome()).toBe("string");
  });

  it("joins the code and token paths", () => {
    expect(codeDir("/h", "books", "abc")).toBe(path.join("/h", "code", "books", "abc"));
    expect(tokenPath("/h", "db-1", "books")).toBe(path.join("/h", "tokens", "db-1", "books.token"));
  });

  it("writes a token file with its folders and reads it back trimmed", () => {
    const file = tokenPath(tmp, "db-1", "books");
    writeTokenFile(file, "secret-token");
    expect(fs.readFileSync(file, "utf8")).toBe("secret-token\n");
    expect(readTokenFile(file)).toBe("secret-token");
  });

  it.skipIf(process.platform === "win32")("keeps a token file private", () => {
    const file = tokenPath(tmp, "db-1", "books");
    writeTokenFile(file, "t");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads null for a missing and for an empty token file", () => {
    expect(readTokenFile(path.join(tmp, "nope.token"))).toBeNull();
    const empty = path.join(tmp, "empty.token");
    fs.writeFileSync(empty, " \n");
    expect(readTokenFile(empty)).toBeNull();
  });

  it("removes a token file, and a missing one is fine", () => {
    const file = path.join(tmp, "a.token");
    writeTokenFile(file, "t");
    removeTokenFile(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeTokenFile(file)).not.toThrow();
  });

  it("hashes text and files", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
    const file = path.join(tmp, "f.txt");
    fs.writeFileSync(file, "some text");
    expect(fileSha256(file)).toBe(sha256Hex("some text"));
  });
});
