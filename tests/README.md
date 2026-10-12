# Test layout

Unit tests live under `tests/*.test.ts` and run with `npx vitest run`.

Engine tests use `tests/helpers/db-vault.ts`: a filesystem-backed fake `App` in a temp directory
(create, rename, trash, frontmatter cache, resolved links). `logVault()` writes the metastore
`Datanotes/metastore.yaml` (its path is exported as `METASTORE`) with the `main.public.log` table
(`LOG_YAML`) and two rows that declare `table: main.public.log` outside the table folder;
`withTables(...)` adds more `main.public` tables to the same file. Rows inserted by the engine land under `LOG_DIR`
(`Datanotes/main/public/log/...`). The tests' database folder is an existing `Datanotes/`
(`TEST_DATABASE_FOLDER`, createDbVault's default `databaseFolder`); a new database of the engine is `datanotes/`.

`tests/fixtures/frontmatter/` holds frontmatter parsing samples.

`tests/examples/<slug>.test.ts` runs one chapter of the docs examples (`docs/examples/`) against a
real engine, through `tests/helpers/examples.ts`: one file per chapter, so they run in parallel.
`tests/examples.test.ts` checks the chapters as a whole: every operation used, every option of the
database shown (`docs/examples/coverage.ts`), and a test file for every chapter.

The errors (CONTRIBUTING.md, "Errors"): `hints.test.ts` tests the standard's functions
(`src/core/hints.ts`, `src/api/guidance.ts`), `hints-engine.test.ts` the engine's errors kind by kind,
`mcp-agent-mistakes.test.ts` an agent's mistakes through the real MCP server on a film diary, and
`error-docs.test.ts` that every docs address a hint gives leads to an existing page and heading.
`tests/helpers/guidance.ts` has the matchers (`guided(error)` for a JSON body, `guidedTextOf(message)`
for a text); the test-vault scenarios' `refused()` requires the `Hint:` and `Docs:` lines.
