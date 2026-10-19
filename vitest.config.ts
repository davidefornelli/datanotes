import { defineConfig } from "vitest/config";
import { BaseSequencer, type WorkspaceSpec } from "vitest/node";

/**
 * Starts the docs examples first (tests/examples.test.ts, tests/examples/). vitest 2 starts the
 * largest test files first (it writes each file's duration to its cache but never reads it back),
 * and these are small files that mostly wait for the engine (hand edits picked up, webhooks sent):
 * started last, they set the length of the run.
 */
class ExamplesFirst extends BaseSequencer {
  async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const sorted = await super.sort(files);
    const example = (f: WorkspaceSpec) => /[\\/]tests[\\/]examples(\.test\.ts$|[\\/])/.test(f.moduleId);
    return [...sorted.filter(example), ...sorted.filter((f) => !example(f))];
  }
}

/*
 * Coverage thresholds: a ratchet (CONTRIBUTING.md, "Test coverage"). Raise them when coverage goes
 * up; never lower one to make a change pass. `npm run test:coverage` checks them, and so does CI.
 */

/** Modules at 100% of lines, functions and branches: they stay there. */
const FULL = [
  "src/api/client.ts",
  "src/api/docs.ts",
  "src/api/guidance.ts",
  "src/api/index.ts",
  "src/api/local.ts",
  "src/api/mcp.ts",
  "src/api/otlp.ts",
  "src/api/requests.ts",
  "src/api/results.ts",
  "src/api/tokens.ts",
  "src/core/actor.ts",
  "src/core/acyclic.ts",
  "src/core/auto-recompute.ts",
  "src/core/autolink.ts",
  "src/core/batch.ts",
  "src/core/body.ts",
  "src/core/changeset.ts",
  "src/core/check-links.ts",
  "src/core/chunk.ts",
  "src/core/computed-columns.ts",
  "src/core/database-history.ts",
  "src/core/datetime.ts",
  "src/core/descriptions.ts",
  "src/core/docs-semantic.ts",
  "src/core/transaction-log.ts",
  "src/core/embeddings.ts",
  "src/core/file-cache.ts",
  "src/core/file-log.ts",
  "src/core/filename-values.ts",
  "src/core/frontmatter.ts",
  "src/core/generated.ts",
  "src/core/graph.ts",
  "src/core/hints.ts",
  "src/core/index-check.ts",
  "src/core/infer.ts",
  "src/core/intern.ts",
  "src/core/journal.ts",
  "src/core/link-names.ts",
  "src/core/link-paths.ts",
  "src/core/log-files.ts",
  "src/core/message.ts",
  "src/core/metastore.ts",
  "src/core/path-templates.ts",
  "src/core/public-api.ts",
  "src/core/query.ts",
  "src/core/relations.ts",
  "src/core/reserved-keys.ts",
  "src/core/row-checks.ts",
  "src/core/row-files.ts",
  "src/core/rows.ts",
  "src/core/select.ts",
  "src/core/semantic.ts",
  "src/core/settings.ts",
  "src/core/store.ts",
  "src/core/table-loader.ts",
  "src/core/table-registry.ts",
  "src/core/telemetry.ts",
  "src/core/this-tokens.ts",
  "src/core/types-table.ts",
  "src/core/unique-index.ts",
  "src/core/uuid.ts",
  "src/core/validate.ts",
  "src/core/vault-index.ts",
  "src/core/vault-path.ts",
  "src/core/where.ts",
  "src/mcp/command.ts",
  "src/mcp/help.ts",
  "src/mcp/http.ts",
  "src/mcp/log.ts",
  "src/mcp/server.ts",
  "src/mcp/tools.ts",
  "src/node/help.ts",
  "src/node/links.ts",
  "src/node/status.ts",
  "src/node/vault-config.ts",
  "src/node/watcher.ts",
  "src/server/docs-ui.ts",
  "src/server/engine-lock.ts",
  "src/server/identities.ts",
  "src/server/openapi.ts",
  "src/server/otlp-sink.ts",
  "src/server/status.ts",
  "src/server/token-routes.ts",
  "src/server/tokens.ts",
];

const floor = (branches: number, lines = 100, functions = 100) => ({ branches, lines, statements: lines, functions });

/**
 * Deterministic modules whose only uncovered branches cannot run (impossible by construction, or
 * a defensive fallback): they move to FULL once those branches carry a `v8 ignore` comment. Until
 * then, their level today (rounded down, the lower of Linux / Node 22 and Windows / Node 24) is
 * their floor. None today: every such module is in FULL.
 */
const NEAR_FULL: Record<string, ReturnType<typeof floor>> = {};

export default defineConfig({
  test: {
    // many tests start an engine, git or a vault on disk: 5 s (the default) is too close on a loaded Windows machine
    testTimeout: 15_000,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // the engine's data home is a temporary folder: tests never write to the user's
    setupFiles: ["tests/setup.ts"],
    sequence: { sequencer: ExamplesFirst },
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/server/**/*.ts", "src/node/**/*.ts", "src/api/**/*.ts", "src/mcp/**/*.ts"],
      exclude: [
        "src/api/catalog.ts", // data (the operations' descriptions and schemas): no logic, 12 800 lines
        "src/core/host.ts", // types only
        "src/core/types.ts", // types only
        "src/node/cli.ts", // the process entry point (runs on import, exits); CI runs the built CLI
      ],
      reporter: ["text", "html"],
      thresholds: {
        // the whole code base: the engine's operations, the HTTP server and tokens, the Node host, the MCP server.
        // Today 99.56 / 99.67 / 99.08 on both Linux / Node 22 and Windows / Node 24: a small margin
        // for the few paths that depend on timing.
        lines: 99.5,
        statements: 99.5,
        functions: 99,
        // 98.5, not 99: timing-dependent paths and Node versions move a few branches between runs
        branches: 98.5,
        ...Object.fromEntries(FULL.map((file) => [file, { 100: true }])),
        ...NEAR_FULL,
      },
    },
  },
});
