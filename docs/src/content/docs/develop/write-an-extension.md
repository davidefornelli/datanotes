---
title: Write an extension
description: "An extension adds tables and MCP tools to any Datanotes database: a git repository with a manifest, a built entry file and docs."
sidebar:
  order: 8
---

An extension is a git repository that adds tables, views, bases and MCP tools to a Datanotes database. You install it with `datanotes extension install`. [Install extensions](/administration/extensions/) covers the user's side.

This page builds a small extension, `acme/datanotes-ext-reading`. It keeps a reading list: books, their authors and what you read now.

## Lay out the repository

The repository holds the manifest at its root, the built entry file the manifest names, and a `docs` folder.

```text
datanotes-ext-reading/
  datanotes-extension.json
  dist/extension.mjs
  docs/
    index.md
    tools.md
  src/extension.ts
  package.json
  README.md
  LICENSE
```

- `dist/extension.mjs` is committed. The installer never runs `npm install`, a build or a script. It copies the files and checks their hashes.
- The entry file is one bundled ES module that imports only Node built-ins. Bundle your code and its libraries into it. The installer reads its imports, minified or not, and refuses a package or another file.
- `docs/index.md` is required. `docs/tools.md` has one `##` heading per tool, named like the tool.
- `README.md` and a licence file travel with the code when present.

Bundle the entry file with esbuild:

```bash
npx esbuild src/extension.ts --bundle --platform=node \
  --format=esm --target=node18 --outfile=dist/extension.mjs
```

Your repository must not ignore `dist/`. Commit the bundle with each release.

## Write the manifest

`datanotes-extension.json` declares the extension's name, version, tables, tools and permissions. Before you confirm, the installer reads only the manifest. So the plan shows what the extension may do, without running its code.

```json
{
  "manifest_version": 1,
  "name": "reading",
  "version": "1.0.0",
  "description": "A reading list: books and who wrote them",
  "datanotes": ">=3.3.0",
  "api": 1,
  "entry": "dist/extension.mjs",
  "default_schema": "reading",
  "instructions": "Call list_reading, then finish_book once a book is read.",
  "tables": {
    "person": {
      "owned": false,
      "names": ["person", "people", "author"],
      "description": "A person: here, the author of a book",
      "filename": "{name}",
      "columns": [
        { "name": "name", "type": "string", "required": true,
          "description": "The person's full name" }
      ]
    },
    "book": {
      "owned": true,
      "description": "A book on the reading list",
      "filename": "{title}",
      "columns": [
        { "name": "title", "type": "string", "required": true,
          "description": "The book's title, as printed on the cover" },
        { "name": "author", "type": "link", "ref": "@person",
          "description": "Who wrote it" },
        { "name": "status", "type": "enum",
          "values": ["to_read", "reading", "read"], "default": "to_read",
          "description": "Where the reader is with it" },
        { "name": "rating", "type": "integer", "min": 1, "max": 5,
          "description": "From 1 to 5, once read" }
      ],
      "constraints": [
        {
          "name": "rating_only_when_read",
          "check": {
            "or": [{ "status": "read" }, { "rating": { "exists": false } }]
          },
          "hint": "Rate a book only once it is read: set status read too."
        }
      ],
      "instructions": "Link author to a row of @{person}.",
      "bases": ["shelved"]
    }
  },
  "bases": {
    "shelved": {
      "description": "Where a thing sits on a shelf",
      "columns": [
        { "name": "shelf", "type": "string",
          "description": "The shelf it sits on" }
      ]
    }
  },
  "views": {
    "vw_reading": {
      "description": "Books being read now",
      "query": { "table": "@book", "where": { "status": "reading" } }
    }
  },
  "permissions": { "write": ["book"] },
  "tools": [
    {
      "name": "list_reading",
      "description": "List the books being read now: title and author.",
      "inputSchema": {
        "type": "object", "properties": {}, "additionalProperties": false
      },
      "annotations": { "title": "List Reading", "readOnlyHint": true },
      "tables": ["book", "person"],
      "writes": []
    },
    {
      "name": "finish_book",
      "description": "Mark a book read, with an optional rating from 1 to 5.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "The book's title" },
          "rating": { "type": "integer", "minimum": 1, "maximum": 5 }
        },
        "required": ["title"],
        "additionalProperties": false
      },
      "annotations": { "title": "Finish Book", "readOnlyHint": false },
      "tables": ["book"],
      "writes": ["book"]
    }
  ]
}
```

The `book` table has a CHECK with its hint, and the base `shelved`. The view `vw_reading` lists the books being read.

Every key at the top level follows a rule:

| Key | Rule |
| --- | --- |
| `manifest_version` | Required. Exactly `1`. |
| `name` | Required. 2 to 40 lowercase letters, digits or `-`, starting with a letter. The token is `ext-<name>`. |
| `version` | Required. `MAJOR.MINOR.PATCH`, with an optional `-pre` suffix. |
| `description` | Required. 1 to 300 characters. |
| `datanotes` | Required. Exactly `">=X.Y.Z"`: the oldest engine version it works with. |
| `api` | Required. Exactly `1`: the module API version. |
| `entry` | Required. A relative path to a `.mjs` file inside the repository, with `/` separators. |
| `default_schema` | Required. Lowercase letters, digits and `_`: the schema of created owned tables and views. |
| `instructions` | Optional. 1 to 400 characters, added to the `datanotes mcp` instructions. |
| `tables` | Required. At least one role. Order matters. |
| `bases` | Optional. The extension's own bases. |
| `views` | Optional. Names start with `vw_`. |
| `permissions` | Required. `write` lists the roles the extension's token may write. It may be empty. |
| `tools` | Required. May be empty. |
| `migrations` | Optional. See [Migrate the schema between versions](#migrate-the-schema-between-versions). |

An unknown key is an error, and the message suggests the closest real key. Tool definitions keep MCP's own field names, such as `inputSchema` and `readOnlyHint`. Every other key is snake_case.

`datanotes extension check` reports every problem at once, each as `<path>: <text>`. A path looks like `tables.book.columns[2].ref`. Common problems:

- `name: must be 2 to 40 lowercase letters, digits or -, starting with a letter`
- `datanotes: must be ">=X.Y.Z", such as ">=3.3.0"`
- `tables.book.columns[1].type: "text" is not a column type (...)` lists the real types.
- `tables.book.columns[1].ref: must be "self" or "@<role>" of a table declared before this one`
- `tools[0].writes[0]: "book" is not in permissions.write`
- `tools[0]: a read-only tool writes nothing (empty writes, or readOnlyHint false)`
- `tools[0]: a tool that writes has readOnlyHint false`
- `tables.book.columns[0]: "id" is the engine's own column: leave it out`

## Declare the tables

Each table has a role: a short name the manifest uses, such as `book`. Tools never use a table's real name. They ask for it with `ctx.table("book")`, so the extension works on any database.

An extension relates to a role in one of two ways:

- **Owned** (`"owned": true`): the extension creates the table, or adopts one of that name. It declares columns, `constraints`, `instructions` and `bases`.
- **Dependency** (`"owned": false`): the table belongs to the user, such as `person`. `names` lists the names that identify a match. The default is the table's name.

These rules apply to tables:

- **Order matters.** A column's `ref: "@person"` names a role declared before it. Put the dependencies first. Use `ref: "self"` for a link to the table itself.
- **`need`** is `"required"` (default) or `"optional"`. On a dependency, it says whether a matched table must have the column.
- **`@{role}`** inside any text is replaced by the role's real table name. Use it in `instructions` and hints.
- **CHECKs** carry a `hint`, what to do when a row breaks the rule. Write one for every CHECK.

The installer compares the manifest with a table it adopts or matches:

- Columns are compared by name and by their rules (type, `ref`, values).
- A missing column is added on an owned table. On a dependency, it is a problem the user solves with `--map` or `--add`.
- CHECKs are compared by name. Equal ones stay. Different ones are replaced, and the plan shows it.
- Instructions that differ are replaced, and the plan shows it.
- Tags are added. Nothing is migrated again.

Version 1 has three limits:

- A manifest cannot declare an `inverse` across two tables. Only `ref: "self"` takes `inverse`.
- The columns of the extension's own tables keep the manifest's names. Users map only dependency columns.
- A dotted key into a dependency, such as `project.kind`, is not mapped in CHECKs and view queries.

## Write the tools

The entry file exports one handler per tool. The default export looks like this:

```ts
import {
  defineExtension,
  ExtensionToolError,
} from "datanotes/extensions";

interface Rows {
  rows: { path: string; title: string; author?: string }[];
}

export default defineExtension({
  api: 1,
  handlers: {
    async list_reading(_args, ctx) {
      const found = await ctx.callTool("select_rows", {
        table: ctx.table("book"),
        where: { status: "reading" },
        columns: ["title", "author"],
      });
      if (!found.ok) throw new ExtensionToolError(String(found.value));
      return { books: (found.value as Rows).rows };
    },
    async finish_book(args, ctx) {
      const book = ctx.table("book");
      const found = await ctx.callTool("select_rows", {
        table: book,
        where: { title: args.title },
        columns: ["title"],
      });
      if (!found.ok) throw new ExtensionToolError(String(found.value));
      const [row] = (found.value as Rows).rows;
      if (row === undefined) {
        throw new ExtensionToolError(
          `no book titled "${String(args.title)}"`,
          "Call list_reading to find the title as written.",
          "tools#finish_book",
        );
      }
      const set: Record<string, unknown> = { status: "read" };
      if (args.rating !== undefined) set.rating = args.rating;
      const done = await ctx.callTool("update_row", {
        table: book,
        path: row.path,
        set,
      });
      if (!done.ok) throw new ExtensionToolError(String(done.value));
      return { path: row.path, status: "read" };
    },
  },
});
```

The types come from `datanotes/extensions`, the package's module API. Your bundle may hold its own copy of `ExtensionToolError`, or a small class of your own. Either works: the host recognises a refusal by its name, `ToolError`.

A handler gets the agent's arguments and a context:

| Member | What it does |
| --- | --- |
| `ctx.callTool(operation, args)` | Runs an engine operation with the extension's token, on behalf of the agent. It never throws for a refusal: read `ok` and `value`. |
| `ctx.table(role)` | The qualified name of the table bound to a role. |
| `ctx.column(role, column)` | The name of a role's column in the bound table: the user's mapping, or the manifest's name. |
| `ctx.hasColumn(role, column)` | Whether the bound table has that column. An optional column may be missing. |
| `ctx.actor()` | The agent that called: `session`, `harness`, `harness_version`, `model`. |
| `ctx.timezone` | The database's time zone, or an empty string. |
| `ctx.log(level, message, attributes)` | A log record through the MCP server's log. |
| `ctx.extension` | `{ name, version }`. |

The extension never sees a token. The MCP server checks the arguments against the tool's `inputSchema` before the handler runs.

### Refuse with a hint

Throw `ExtensionToolError(message, hint, docs)` for a mistake the agent can fix. The message says what is wrong. The hint says how to fix it. `docs` is a page of your docs, with an optional anchor: `"tools#finish_book"`. The agent reads:

```text
no book titled "Dune"
Hint: Call list_reading to find the title as written.
Docs: read_docs("extensions/reading/tools#finish_book")
```

Write a `## finish_book` heading in `docs/tools.md` for every link you give. Any other error becomes `extension reading failed in finish_book: <message>`, and the server logs it.

### Declare what a tool writes

Each tool lists `tables`, the roles it reads or writes, and `writes`, the roles it writes. Every role in `writes` must be in `permissions.write`. A tool with `readOnlyHint: true` has an empty `writes`. A tool that writes has `readOnlyHint: false`.

Before a tool with a non-empty `writes` runs, the server checks the calling agent's token. That token must be able to write those tables. A token that may not write them gets a refusal. This is why a wrong `writes` list matters: declare it exactly.

A tool with an empty `writes` may not write rows, even if the extension's token could. The server refuses these calls from the tool's handler:

- `batch`
- `restore_table`
- any operation that writes rows, such as `insert_row` or `update_rows`

The refusal reads `tool <tool> of extension <name> declares no writes: it may not call <operation>`. To write, declare the roles in `writes` and set `readOnlyHint: false`. Otherwise, call a read operation.

### Log without leaking

Call `ctx.log` with a constant message and put the variable parts in attributes. Never log argument values, tokens or note text.

## Migrate the schema between versions

The manifest always describes the latest schema. `migrations` lists the operations that bring a database from an older version to the new one. A migration holds only declarative operations, the ones `batch` takes.

```json
"migrations": [
  {
    "version": "1.1.0",
    "description": "Record the day a book was finished",
    "operations": [
      {
        "op": "add_column",
        "table": "@book",
        "column": {
          "name": "finished_on",
          "type": "date",
          "description": "The day the book was finished"
        }
      }
    ]
  }
]
```

Follow these rules:

- Versions increase down the list, and none is later than the manifest's `version`.
- `@book` is replaced by the real table name, as everywhere in the manifest.
- A step whose effect is already there is skipped, so a migration runs safely twice.
- A migration cannot run code. A data conversion is out of scope for version 1.

An update also reconciles the tables with the new manifest by itself. It adds missing columns, CHECKs, instructions, tags, bases and views, and replaces CHECKs that changed. List a migration only when you rename, move or drop something. The installer never drops a column unless a migration does.

## Check and publish an extension

Run the check in the repository. It validates the manifest and the files without a database:

```bash
datanotes extension check .
```

While you develop, install from the folder on a test copy of a database, never your real one:

```bash
datanotes extension install ./datanotes-ext-reading \
  --database ~/scratch/notes-copy
datanotes extension update reading --from ./datanotes-ext-reading \
  --database ~/scratch/notes-copy
```

To publish, follow these steps:

1. Set `version` in the manifest.
2. Rebuild `dist/extension.mjs` and commit it.
3. Run `datanotes extension check .`.
4. Tag the commit `v<version>`, for example `v1.0.0`. The tag must name the manifest's version.
5. Push the tag. Users install with `owner/repo@v1.0.0`.

An out-of-date `dist` is the most common mistake: the installer ships what is committed.
