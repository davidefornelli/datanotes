# Contributing

Thank you for helping. Open an issue before a large change, so we can agree on the approach.
Read [What we accept](#what-we-accept) first, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22 or later. On Windows, use Node.js 24.16.0 or later (or 26.1.0 or later):
earlier versions abort at random (exit `0xC0000409`) on connections to `127.0.0.1`, a libuv bug.

```bash
npm ci                  # the dependencies, as package-lock.json pins them
npm run verify          # everything CI checks: run it before you open a pull request
npm run verify:fast     # layers, types and the tests of your changes, in seconds
npm test                # unit tests (an in-memory vault)
npm run test:node       # the engine tests on the headless Node host
npm run bench           # scale benchmark (SIZES=1000,5000,20000), not part of npm test
npm run build:service   # dist/datanotes.cjs, the `datanotes` command
npm run check:package   # the npm package's types (attw, publint, a nodenext consumer): after build:service
```

`npm run verify` also builds the docs, which needs `cd docs && npm ci` once;
`npm run verify:no-docs` skips them.

## Code layout

- `src/api/` — the catalogue of operations and the HTTP client, published as `datanotes/client`
  (and `datanotes/local`), and the engine's operations as MCP tool definitions, `datanotes/mcp`
  (`mcp.ts`, without the MCP SDK). It imports nothing else: MCP servers, apps, scripts and
  plugins use it. It compiles with `NodeNext` (`tsconfig.api.json`): write its relative imports
  with `.js` (`./catalog.js`), or the published types break for nodenext consumers.
- `src/core/` — the engine (tables, validation, journal, queries, …). It reaches the vault only
  through `src/core/host.ts` and never imports `obsidian`.
- `src/server/` — the HTTP API: routes, server, named tokens, webhooks, the engine lock, the change-feed
  endpoints.
- `src/node/` — the headless host: the same `VaultHost` on a folder of the filesystem (file and
  link index, rename that rewrites links, trash, watcher), behaving like Obsidian; the engine
  tests also run on it (`npm run test:node`). With `VAULT_HOST_TESTS_ONLY=1` it runs only the test
  files that reach the vault helper (`tests/helpers/db-vault.ts`): the others do the same on either
  host, so CI on Linux runs them once.
- `src/mcp/` — the MCP server, `datanotes mcp` (stdio and Streamable HTTP): its tools are the
  operations of `src/api/catalog.ts` (through `src/api/mcp.ts`). A client of the HTTP API: it imports only
  `src/api` and the MCP SDK, never the engine.

The MCP server lives here too, in `src/mcp/` (`datanotes mcp`): it imports only `src/api` and the MCP
SDK, which is a devDependency bundled into `dist/datanotes.cjs`, and reaches the engine over HTTP like
any other client.

`npm run build` checks these boundaries first (`scripts/check-layers.mjs`). The Node host is checked
against Obsidian's own behaviour by an opt-in golden test (`tests/golden-obsidian.md`).

Why the project is called Datanotes: [NAMING.md](NAMING.md).

## Test coverage

```bash
npm run test:coverage   # every test, with coverage of src/core, src/server, src/node and src/api
```

It fails when coverage falls below the thresholds in `vitest.config.ts`, and CI runs it (job
`coverage`). Not measured: `src/api/catalog.ts` (the operations' descriptions and schemas: data, no
logic), the files that only declare types, and `src/node/cli.ts` (the process entry point; CI runs
the built command). The thresholds are a ratchet: coverage may go up, never down.

- **100% for the deterministic modules** (`FULL` in `vitest.config.ts`): metastore parsing, table
  definitions, `where` filters and CHECKs, value validation, path templates, generated and
  identity columns, `{this.*}` tokens, the journal, the client and its requests, and the other
  modules whose every branch an input can reach. They keep 100% of lines, functions and branches:
  a change to one comes with the tests of its new branches, and a new module of that kind joins
  the list. `NEAR_FULL` lists the deterministic modules whose only uncovered branches cannot run;
  they move to `FULL` once those branches carry an exclusion (below).
- **A floor for the rest** (global thresholds: the engine's operations, the HTTP server and the
  tokens, the Node host, git sync). When a change raises coverage, raise the floor to the new value
  rounded down; never lower a threshold to make a change pass.
- **Exclusions.** A branch no test should reach is excluded in the code, on the line before it,
  with the reason: `/* v8 ignore next -- impossible: split() always returns an element */`
  (`/* v8 ignore start */` … `/* v8 ignore stop */` for a block). Valid reasons: impossible by
  construction, a defensive fallback for an error the platform does not raise, a path that runs
  only on another operating system. "Hard to test" is not one: an injected transport, a fake
  clock or a temporary vault reaches most branches. Every new exclusion is pointed out in the
  pull request. Prefer code that has no such branch: a non-null assertion with a comment where
  the value is always there, and `messageOf(e)` (`src/core/message.ts`) for the text of a thrown
  value instead of `e instanceof Error ? e.message : String(e)`.
- **What a test is.** Tests check behaviour: realistic input, the exact result, refusals with
  their exact message and error class. A test that only runs a line is not a test.

## Errors

Datanotes serves agents first, and an agent learns from its mistakes only when the error teaches it.
Every error says three things:

1. **What is wrong**: the message (`error`), whose beginning stays stable once released
2. **How to fix it**: `hint`, one or two sentences. Where the answer is data, the hint reads it from
   the database: the closest real name (`Did you mean "title"?`, by spelling, case and aliases), the
   allowed values, the columns, the tables. Otherwise it gives the right shape or an example, and
   names the operation that looks the answer up (`describe_table`, `list_tables`, `list_link_targets`, …).
3. **Where to read more**: `docs`, a Markdown page of the site with its anchor
   (`https://datanotes.dev/<route>.md#<heading>`), which agents read best

The engine's half is `src/core/hints.ts`: the docs topics (`DOCS`), `GuidedError` (the base of
`OperationInputError`, `QueryInputError`, `TableNotFoundError`, `MetastoreError`, …, whose second
argument is the guidance), `closestNames` and `unknownName` / `unknownColumn` for "did you mean",
`unknownOperator` for filters, the guidance of each kind of violation and of the usual conflicts.
`src/core/table-registry.ts` has `tableNotFound`. The client's half is `src/api/guidance.ts`: the
check of a tool's arguments against its schema (`checkArguments`), unknown tools, and `guidedText`,
which appends `Hint:` and `Docs:` lines to the text an agent reads.

The HTTP API sends `hint` and `docs` next to `error` (`errorResponse` in `src/server/rest.ts`), and
adds them to refused writes (422), refused undos (409) and refused batches. An error that carries no
guidance of its own gets its kind's: for bad input, the arguments and the reference of the
operation the route runs. Unexpected errors (500) have none. `resultOf`, `DatanotesError` and the
MCP server end the agent's text with the two lines.

What the engine and the MCP server can answer, and what each answer says (the docs site's
[Errors](https://datanotes.dev/reference/errors/) reference is generated from `src/core/hints.ts`; the
docs paths below are under `guides/` unless they name another folder):

| Error | Where | Status | Hint | Docs |
| --- | --- | --- | --- | --- |
| Unknown tool or operation | `callProblem` (`src/api/mcp.ts`), `operationRequest` | tool error, refusal | the closest tools | `/reference/operations.md` |
| Argument unknown, missing or of the wrong type | `checkArguments` (MCP server, `callEngineTool`) | tool error, never sent | the argument meant; the tool's arguments with their types | `/reference/operations/<kind>.md#<op>` |
| Bad route input (`BadRequest`: `"x" is required`, `must be …`) | `src/server/rest.ts`, `tokens.ts` | 400 | its own, or the operation's arguments | the operation's reference, or the tokens guide |
| Bad operation input (`OperationInputError`, about 300 places) | `src/core/*` | 400 | its own where the answer is data, else the operation's arguments | the topic's page, or the reference |
| Table or view not found | `tableNotFound` | 404 | closest names and aliases; the tables and views; a view where a table is needed | `database-objects/tables.md#find-the-table-that-matches-a-request`, `database-objects/views.md#store-a-query-as-a-view` |
| Ambiguous table name | `AmbiguousCatalogRefError` | 409 | the full names | `database-objects/catalogs-and-schemas.md#place-tables-in-catalogs-and-schemas` |
| Unknown column (writes, `where`, `columns`, `order_by`, joins, groups, schema changes) | `unknownColumn`, `unknownWriteColumn` | 400 | closest column; the table's columns; `describe_table`, `add_column` | `database-objects/tables.md#describe-a-table-before-writing-to-it`, `read-and-write/read-and-filter.md` |
| Unknown filter operator (reads, views, CHECKs) | `unknownOperator` (`where.ts`) | 400 | the operator meant (typo or synonym); every operator; the condition's shape | `read-and-write/read-and-filter.md#compare-values-with-operators` |
| Bad expression or aggregate | `query.ts` | 400 | the columns; the shape | `read-and-write/joins-and-aggregates.md#group-rows-and-compute-totals` |
| Unknown base, constraint, catalog, schema, enum value, link column | `select.ts`, `catalog-ops.ts`, `engine.ts`, `link-targets.ts`, `graph.ts` | 400 | closest name; the list; the operation that lists them | the topic's page |
| A name that is not an identifier | `identifierHint` | 400 | the name it could be | `database-objects/catalogs-and-schemas.md#place-tables-in-catalogs-and-schemas` |
| A table, base or column without a description, or one removed | `src/core/descriptions.ts` | 400 | every missing description; the call's shape with each in place | `database-objects/tables.md#describe-every-table-and-column` |
| Row not found (`update_row`, `list_link_targets`, `within`) | `row-ops.ts`, `link-targets.ts`, `where.ts` | 400 | closest note name; how to find `path` or `id` | `read-and-write/write-rows.md#update-one-row` |
| Violations: required, type, enum, vocabulary, min, max, step, link, ref, unique, unknown column, CHECK, generated, cycle, inverse; unreadable (check_table and the change feed only) | `validate.ts`, `row-checks.ts`, `link-targets.ts`, `computed-columns.ts`, `inverse.ts`, `unreadable.ts` | 422 | each kind's (`violationGuidance`); the message names the values | each kind's page |
| Conflicts: `expect`, linked rows, rows breaking a new CHECK, readers of a column, `cascade`, names taken (also in another case), merge keys | `CONFLICTS` | 422 | what the conflict means and what to do | each kind's page |
| Failed write (rolled back by the engine, `rolled_back`; or its rollback failed too) | `refusalGuidance` | 500 (body is the result) | free the file and retry; `undo_migration` on `migration_id` when the rollback failed | `history/journal-and-undo.md#the-engine-rolls-back-a-write-it-cannot-finish`, `#when-the-rollback-cant-finish-either` |
| Undo refused, migration not found | `undoGuidance`, `errorResponse` | 409, 404 | undone already; later changes; `list_migrations` | `history/journal-and-undo.md#undo-…` |
| History: none, no such version, before the table existed, `version` with several tables | `history.ts`, `select.ts` | 400 | `alter_table` with `history: "on"`; `describe_history`; `timestamp` | `history/table-history.md` |
| Batch: an operation refused or unknown | `batch.ts`, `rest.ts` | 422, 400 | each step's own; fix and resend the whole batch | `read-and-write/batch.md#group-several-writes-with-batch` |
| Token permission | `tokens.ts`, `Forbidden` | 403 | the permissions and who changes them | `security/tokens.md#choose-what-a-token-can-do` |
| Token missing or wrong | `http-server.ts`, `DatanotesError` (`auth`), `src/mcp/http.ts` | 401 | which token, as a bearer token | `develop/http-api.md#authenticate-your-requests` |
| Unknown route, method or body | `http-server.ts` | 404, 405, 400 | the routes in `openapi.json`, the closest route | `develop/http-api.md#call-the-engines-routes` |
| Note or folder not found | `http-server.ts`, `read_note` | 404 | vault paths; `list_folder` | `search/text.md#read-a-note` |
| Change feed, webhooks or semantic search off | `public-api.ts`, `rest.ts` | 400, 503 | how to turn it on | `history/change-data-feed.md`, `search/semantic.md` |
| Engine unreachable | `DatanotesError` (`unreachable`), `src/mcp/http.ts` | thrown, 502 | start the engine, check its address | `start/connect-agents.md#how-the-mcp-server-reaches-the-engine` |
| The engine cannot listen: a port in use or reserved, an address of another machine; a bad `--port` | `listenError` (`http-server.ts`), `parsePort` (`service.ts`) | exit 1 of `datanotes serve` | another `--port`, `--port 0`, an address of this machine | `administration/run-the-service.md#choose-the-port` |
| A request while the engine stops; a bad `--timeout-s` of `datanotes stop`; `GET /stop/` | `http-server.ts`, `stop.ts` | 503, exit 1, 405 | wait for the stop, then start the engine again; POST | `administration/run-the-service.md#stop-the-engine` |
| Store backup: a database without an id, a file over 95 MB to push | `store-backup.ts`, `store-command.ts` | `store_backup.hint` of the status, exit 1 | start the engine once; make the file smaller and start the repository again | `guides/history/back-up.md#…` |
| Unexpected error | `errorResponse` | 500 | none: not a mistake of the caller | none |

Hand edits that break a rule are not errors: `check_table` and the change feed report them, and an
`unknown_column` among them names the column meant.

A new error follows the standard and gets a test of its hint and docs (`tests/hints.test.ts`,
`tests/hints-engine.test.ts`; through the MCP server, `tests/mcp-agent-mistakes.test.ts`). Every
refusal of the test-vault scenarios must end with `Hint:` and `Docs:` lines
(`tests/helpers/test-vault.ts`), and `tests/error-docs.test.ts` checks that every docs address the
hints give leads to an existing page and heading.

## Documentation

The site at [datanotes.dev](https://datanotes.dev) is built from `docs/` (Astro Starlight) and
published on every push to `main` as a Cloudflare Worker with static assets
(`.github/workflows/docs.yml`, `docs/wrangler.jsonc`). Some pages are generated from the code by `scripts/gen-docs.mjs` and are not
committed: the reference of the operations, one page per kind (`src/api/catalog.ts`: each
operation's kind is in `OPERATION_KIND`, and `tests/operation-kinds.test.ts` checks that every
operation has exactly one), the settings (`src/core/settings.ts`), the command line
(`src/node/help.ts`), the errors (`src/core/hints.ts`), `SECURITY.md`, `deploy/docker/README.md`,
`openapi.json` and the guide pages made from the examples (below). Change the source, not the page. The build also writes
`llms.txt`, `llms-full.txt` and `llms-small.txt` ([llmstxt.org](https://llmstxt.org/)) from the same
pages (plugin `starlight-llms-txt`, configured in `docs/astro.config.mjs`).

Every page is also published as Markdown, for people and agents: `/start/quick-start/` is also
`/start/quick-start.md`, the home page `/index.md` (`docs/src/markdown-pages/`). The content pages go
through `starlight-llms-txt`'s own converter (MDX components rendered, code blocks with their
language, links made absolute); the HTTP API pages under `/api/` are written from `openapi.json`.
Each HTML page links its `.md` in `<head>` (`<link rel="alternate" type="text/markdown">`) and in its
footer, and `docs/worker.js` serves the `.md` files as `text/markdown` (a page asked for with
`Accept: text/markdown` gets its `.md`). The build fails when a page has no `.md`, or one that is
empty, has no `# Title` or keeps MDX or HTML tags outside code (`docs/src/markdown-pages/check.js`,
tested with the worker in `tests/docs-markdown.test.ts`). A new page needs nothing more; a new kind
of page (another plugin's routes) needs its `.md` in `docs/src/markdown-pages/page.md.ts`.

The site is organized by area, like the Databricks docs: Get started, Guides (database objects, data
quality, reading and writing, search, history and recovery, agents, security), Develop, Reference,
Administration and Release notes (the sidebar is in `docs/astro.config.mjs`). A page that moves gets
a redirect in `docs/worker.js` (`MOVED`, tested in `tests/docs-markdown.test.ts`).

The guide pages of the areas (`guides/database-objects/`, `data-quality/`, `read-and-write/`,
`search/`, `history/`) are made from `docs/examples/`: each chapter is a list of calls with what they
show, run in order on a vault of its own, and `docs/examples/pages.ts` puts each example on the page
of its area, with the page's intro (and, for a guide with prose of its own, a Markdown file it
includes). Every example is on exactly one page. The build runs every one against a real engine on a
temporary vault and prints the engine's own answers (`docs/examples/run.ts`). A call that answers differently from what its page says (works
where it should be refused, or the reverse, or fails a `check`) fails the build and the chapter's
test, `tests/examples/<slug>.test.ts` (a new chapter needs one, or `tests/examples.test.ts` fails
naming it). Every operation in `src/api/catalog.ts` must appear in at least one example:
a new operation without one stops the docs build. So must every option that defines the database
(`docs/examples/coverage.ts`, which reads them from the code): each parameter of the operations that
write `metastore.yaml`, each column attribute and table option, passed by an example call the engine
accepts; and each key and kind of value `metastore.yaml` can hold, in a `metastore.yaml` a page shows
(`showFile`). Not checked: the parameters of `undo_migration` and `batch`, which write only what
other operations define (`NOT_DEFINING`), and `dry_run`, which every write takes (`EXCEPTIONS`,
where each exception gives its reason). A new option without an example stops the build and fails
the test, naming the option.

```bash
cd docs && npm install && npm run dev
```

## Names

Every name a program reads follows one guide. `tests/naming.test.ts` checks the rules a machine
can check on every operation of `src/api/catalog.ts`:

1. One name per concept, the same in MCP, the client and HTTP (`POST /datanotes/operations/<name>/`
   takes the operation's arguments as they are).
2. JSON is snake_case, arguments and answers alike. A field the engine adds to a row, beside the
   row's own columns, starts with `_` (`_change_type`). Environment variables are `DATANOTES_*`,
   command options kebab-case, keys of the settings file camelCase.
3. No argument is a reserved word of Python or JavaScript: `from_column`, not `from`.
4. An existing object is passed by its type (`table`, `column`, `view`); a new one, or a new name,
   is `name`.
5. `path` is always the vault path of a note or file.
6. `rows` and `tables` are always lists; a count says so (`row_count`, `rows_checked`).
7. An explanation is a `description`, never a comment.
8. A folder is a folder, never a directory.
9. A duration has its unit in its name (`_ms`, `_s`, `_min`, `_days`).
10. Every enum is declared in the input schema, with snake_case values.
11. Following the default is `"default"`, never `"inherit"`.
12. An answer is built field by field, never by copying an object of the engine; clients ignore
    fields they don't know.

## Compatibility

Datanotes 3 is meant to stay 3: what works in 3.0 works the same in every 3.x
([Compatibility](https://datanotes.dev/reference/compatibility/)). Before you change anything a
program reads:

- **Add, don't take away.** An operation, argument, answer field, route, command option,
  environment variable or setting never goes.
- **A new meaning gets a new name.** The old name keeps doing what it did.
- **The contract file.** `contract/datanotes-3.txt` lists the public contract, one line per part.
  `tests/contract.test.ts` fails when a line goes or a new part is missing. Run
  `npm run contract:update` to add the new lines and commit the file; a line never leaves it.

## Releasing

Versions follow [semantic versioning](https://semver.org) inside the compatibility promise:
**PATCH** (`3.y.Z`) for fixes, **MINOR** (`3.Y.0`) for additions. A new major version is not
planned. Security fixes may change a behaviour in a
minor or patch version, with a note in the release notes.

Set `"version"` in `package.json` and both `"version"` fields of `server.json` (the MCP Registry
entry; `tests/mcp-registry.test.ts` checks they match), commit, then publish a GitHub release with
the tag `vX.Y.Z`: `.github/workflows/release.yml` tests and publishes the npm package (trusted
publishing, no token). It runs as soon as the release is published. The tests run first; the
publish job then waits in the `npm` environment until a required reviewer approves it.
`gh workflow run release.yml` retries a release whose publication failed.

## What we accept

Datanotes 3 never takes a part of its contract away (see [Compatibility](#compatibility)), so every
addition stays for good. These rules follow:

- **Fixes, tests and docs.** Welcome without an issue: a bug fix with its test, a missing test, a
  clearer page, a better error hint.
- **Anything new in the public contract needs an approved issue first.** That is any change that
  adds a line to `contract/datanotes-3.txt`: an operation, argument, answer field, route, command
  option, environment variable or setting. Open a feature request, wait until the maintainer
  approves it, then open the pull request and link the issue. A pull request that adds a line
  without one is closed, however good the code.
- **Large changes need an issue too.** Agree on the approach before you write a refactor, a new
  dependency or a change to how the engine stores data.
- **One concern per pull request.** Keep unrelated changes apart, so each can be reviewed and
  reverted alone.
- **Sensitive files get a closer review.** Changes to `.claude/`, `scripts/`, the `scripts` of
  `package.json` and `.github/` run code on other people's machines or in CI. Mark them in the pull
  request template and explain why each is needed.

Every pull request must pass `npm run verify` and follow the rules of this file: errors with
`hint` and `docs`, an example for every new option, the naming guide, the docs writing guidelines,
English only, and invented names in tests and docs, never real notes or personal data.

## AI-assisted contributions

AI-assisted contributions are welcome on three conditions:

1. **You understand the change.** You can explain every line and answer the review yourself.
2. **You tested it.** `npm run verify` passes on your machine, and the change has the tests it needs.
3. **You declare it.** Say in the pull request which AI tools you used and for what.

You take responsibility for the contribution, as if you had written every line by hand. A pull
request that looks generated and untested, or that hides its AI use, is closed.

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0. Section
5 of the license covers contributions, so there is no Developer Certificate of Origin (DCO) to
sign off and no Contributor License Agreement (CLA) to sign.
