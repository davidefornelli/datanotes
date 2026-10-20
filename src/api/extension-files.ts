/**
 * Where an extension's files live on this machine (<data home>/extensions): the immutable code of each
 * installed commit and the secret of the extension's token. The installation record itself is in the
 * engine's store. No Node types in the exported signatures: the package's consumer check compiles
 * without them.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataHome } from "./local.js";

export const EXTENSIONS_FOLDER = "extensions";

/** <data home>/extensions. */
export function extensionsHome(env: Record<string, string | undefined> = process.env): string {
  return path.join(dataHome(env), EXTENSIONS_FOLDER);
}

/** The folder holding an immutable copy of an extension's published files at one commit. */
export function codeDir(home: string, name: string, commit: string): string {
  return path.join(home, "code", name, commit);
}

/** The file holding an extension's token for one database. */
export function tokenPath(home: string, databaseId: string, name: string): string {
  return path.join(home, "tokens", databaseId, `${name}.token`);
}

/** SHA-256 of the raw bytes, hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of a file's bytes, hex. */
export function fileSha256(file: string): string {
  return sha256Hex(fs.readFileSync(file));
}

/** Write a token file (the token and a newline, mode 0600), creating its folders. */
export function writeTokenFile(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  /* v8 ignore next -- a Windows file has no mode to set */
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

/** The token in a file, trimmed; null when the file is missing or empty. */
export function readTokenFile(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const token = text.trim();
  return token === "" ? null : token;
}

/** Delete a token file; a missing one is fine. */
export function removeTokenFile(file: string): void {
  fs.rmSync(file, { force: true });
}
