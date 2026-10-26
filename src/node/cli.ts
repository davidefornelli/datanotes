/**
 * The `datanotes` command (the npm package's bin, and `dist/datanotes-service.cjs`).
 *
 *   datanotes serve --vault <folder> [service options]   the engine with its HTTP server
 *   datanotes status --vault <folder> [--json]            the running engine's health (exit 0 / 1 / 2 / 3)
 *   datanotes stop --vault <folder> [--timeout-s 60]      a graceful stop of the running engine (exit 0 / 1 / 2 / 3)
 *   datanotes store path | new-id --vault <folder>       where the store is; a new id for a copied database
 *   datanotes extension install | update | rollback | remove | list | check   extensions (src/node/extension-command.ts)
 *   datanotes mcp [--vault <folder> | --url <url> | serve] the MCP server for agents (src/mcp)
 *   datanotes pack-merge <base> <ours> <theirs> [<path>]  git's merge driver of packs of rows
 *
 * Without a command, options alone mean `serve` (how the service has always been started). The MCP
 * server is its own process, a client of this HTTP API: `datanotes mcp` never starts the engine in
 * the same process (with --vault it may spawn `datanotes serve` as a child).
 */

// first: the thread pool's size is read when the pool starts (threadpool.ts)
import "./threadpool";
import { main as serve } from "./service";
import { main as status } from "./status";
import { main as stop } from "./stop";
import { main as store } from "./store-command";
import { guidanceOf } from "../core/hints";
import { help } from "./help";
import { messageOf } from "../core/message";
import { nodeVersionWarning } from "./node-version";

declare const SERVICE_VERSION: string | undefined;
const VERSION = typeof SERVICE_VERSION === "string" ? SERVICE_VERSION : "dev";

/** The console's own error output: `serve --log` sends `console.error` to the log file. */
const consoleError = console.error;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") return void process.stdout.write(`${VERSION}\n`);
  if (!command || command === "--help" || command === "-h" || command === "help") return void process.stdout.write(`${help(VERSION)}\n`);
  if (command === "serve") return serve(rest);
  if (command === "status") return void (process.exitCode = await status(rest));
  if (command === "stop") return void (process.exitCode = await stop(rest));
  if (command === "store") return void (process.exitCode = await store(rest));
  if (command === "pack-merge") {
    // git's merge driver of packs of rows (src/node/pack-merge.ts): git sync registers it
    const { packMergeMain } = await import("./pack-merge");
    return void (process.exitCode = packMergeMain(rest));
  }
  if (command === "extension") {
    // loaded only for this command, like mcp
    const { extensionMain } = await import("./extension-command");
    return void (process.exitCode = await extensionMain(rest));
  }
  if (command === "mcp") {
    // loaded only for this command: `serve` does not pay for the MCP SDK at start
    const { mcp } = await import("../mcp/command");
    console.log = (...a: unknown[]) => console.error(...a); // stdout carries only MCP messages
    const warning = nodeVersionWarning();
    if (warning) console.error(warning);
    await mcp(rest, VERSION, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      // this bundle (dist/datanotes.cjs), whatever started it (npx or another script)
      engineCommand: [process.execPath, __filename],
      exit: (code) => process.exit(code),
      onSignal: (signal, handler) => void process.on(signal, handler),
    });
    return;
  }
  if (command.startsWith("--")) return serve(argv);
  throw new Error(`unknown command "${command}" (datanotes --help)`);
}

main().catch((e: unknown) => {
  const g = guidanceOf(e);
  // an error that says how to fix it: the hint, and where to read more
  const text = `datanotes: ${messageOf(e)}${g ? `\n${g.hint}\nSee ${g.docs}` : ""}`;
  console.error(text);
  // with `serve --log` the line above went to the log file: whoever started the command sees it too
  if (console.error !== consoleError) process.stderr.write(`${text}\n`);
  process.exit(1);
});
