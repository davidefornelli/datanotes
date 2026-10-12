#!/usr/bin/env node
/**
 * `npm run dev`: the built engine (`dist/datanotes.cjs serve`) on a temporary COPY of
 * `test-vault/`, so the committed vault stays as it is.
 *
 *   npm run build:service && npm run dev [-- --port 27180] [-- --keep]
 *
 * The port is `--port`, else DATANOTES_DEV_PORT, else a free one (never the default 27150, which
 * a real engine may be using). The engine's store is a temporary folder too (`--store`); the
 * owner's token is in its `settings.json`, and printed. Ctrl+C stops the engine and deletes the
 * copy and its store (unless `--keep`).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "dist", "datanotes.cjs");
const source = path.join(repo, "test-vault");
if (!fs.existsSync(cli)) {
  console.error("dist/datanotes.cjs is missing: run npm run build:service first");
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const keep = argv.includes("--keep");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const port = Number(arg("port") ?? process.env.DATANOTES_DEV_PORT ?? (await freePort()));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-dev-vault-"));
fs.cpSync(source, vault, { recursive: true, filter: (src) => path.relative(source, src).split(path.sep)[0] !== ".datanotes" });
// the engine's store: a temporary folder next to the copy (never the user's data folder)
const store = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-dev-store-"));
const settings = path.join(store, "settings.json");
fs.writeFileSync(settings, JSON.stringify({ httpServerPort: port, fileLogEnabled: false }, null, 2));

const child = spawn(process.execPath, [cli, "serve", "--vault", vault, "--store", store, "--watch", "poll", "--poll-ms", "1000"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, DATANOTES_DATA_HOME: store },
});
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  if (String(d).includes("http://")) {
    let token = "";
    try {
      token = JSON.parse(fs.readFileSync(settings, "utf8")).httpServerToken ?? "";
    } catch {}
    console.log(`\nDatanotes dev engine on a copy of test-vault/`);
    console.log(`  vault: ${vault}`);
    console.log(`  store: ${store}`);
    console.log(`  url:   http://127.0.0.1:${port}  (API docs: /datanotes/docs)`);
    console.log(`  token: ${settings} (httpServerToken${token ? `: ${token}` : ""})`);
    console.log(`  try:   curl -s -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:${port}/datanotes/operations/list_tables/\n`);
  }
});

const cleanup = () => {
  if (keep) return;
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
};
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    child.kill(sig === "SIGBREAK" ? "SIGTERM" : sig);
  });
}
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
