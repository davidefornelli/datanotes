---
title: Read the docs offline
description: "The datanotes package ships these docs as Markdown for its version: agents read and search them with list_docs, read_docs and search_docs, programs through the engine, people from the package."
sidebar:
  label: Docs Offline
  order: 4
---

The `datanotes` package ships this documentation as Markdown: one file per page of the site in `dist/docs/`, with `llms.txt`. The pages match the installed version, and reading them needs no internet access.

## The agent reads the docs of its version

`datanotes mcp` serves these pages to agents. The agent looks up an operation or an example without internet access, and the pages always match the version it talks to. Three tools read them:

- **`list_docs`**: lists the pages, each with its path, title and description. `prefix` keeps one folder, such as `guides/`.
- **`read_docs`**: returns a page as Markdown, or one section of it by the anchor of its heading, such as `guides/read-and-write/read-and-filter#compare-values-with-operators`. It returns at most 20,000 characters at a time, and a longer text ends with how to read the rest.
- **`search_docs`**: finds the sections that match a few words, best first. Each hit has the path to pass to `read_docs` and a short excerpt.

The `Docs:` line of an error names the `read_docs` call for its section, so the agent reads it offline at once:

```text
Docs: read_docs("guides/read-and-write/read-and-filter#compare-values-with-operators")
```

The server leaves out the web address, since its agents always have the docs tools. A program that uses `DatanotesClient` gets both: the address, then the `read_docs` call in parentheses. Your own MCP server with the docs tools drops the address with `offlineDocs` from `datanotes/mcp`.

An agent that asks for a page or section that doesn’t exist gets the closest ones in the hint. Reading a section instead of a whole page keeps the agent’s context small: `search_docs` finds the section, and `read_docs` returns only that.

## Search with required and excluded words

`search_docs` ranks the sections by the words of the query. A word matches in any form, so `rows` finds `row`. It also matches its synonyms, so `revert` finds `undo`. Words in a heading count most.

Three marks narrow the search:

- **`"a phrase"`**: the section must hold these words in a row, in any form, such as `"time travel"`
- **`+word`**: the section must hold the word, such as `+view`
- **`-word`**: the section must not hold the word, such as `-sql`; `-"a phrase"` leaves out a phrase

The other words only rank the sections. This query finds the sections on time travel that mention views and never SQL. Here, `db` is a [client](/develop/client/) connected to the engine, as in [Build your own MCP server](/develop/build-on-datanotes/#build-your-own-mcp-server):

```ts
import { callDocsTool } from "datanotes/mcp";

const hits = await callDocsTool(
  "search_docs",
  { query: '"time travel" +view -sql' },
  { client: db },
);
```

The marks filter the results, and never rank them. A section with every required word still ranks by all the words of the query. A word that starts with two dashes, such as `--vault`, is a plain word.

## Search by words and by meaning

When the engine has [semantic search](/guides/search/semantic/) on, `search_docs` becomes a hybrid search. It ranks the sections twice:

- **By words**: the ranking above, made by the MCP server from its own copy of the docs
- **By meaning**: the engine embeds the query and ranks the sections by the similarity of their vectors

Reciprocal Rank Fusion merges the two rankings. Each section scores the sum of 1 / (60 + its rank) over the rankings that hold it. Only the first 50 sections of each ranking count. A section that both rankings place high comes first, ahead of one that a single ranking finds. The required and excluded words filter both rankings.

Each hit then ends with the rankings that found it: `(keyword, semantic)`, `(keyword)` or `(semantic)`. The last line of the answer says the search was hybrid.

This is the hybrid search of vector databases such as ChromaDB, with no service to add. The engine already has the embedding model of semantic search. It keeps the vectors of the docs in its store, in `semantic/docs.json`, apart from the index of your notes.

The engine builds that index in the background:

- **When it starts**: after it updates the index of your notes
- **When the docs change**: after an upgrade or a new docs build, the engine embeds again only the sections whose text changed
- **When the model changes**: another provider, address or model starts a new index

The version of the docs is a hash of their sections, so any change to a section counts. The docs are public: embedding them sends nothing from your vault. With a paid provider, the docs cost about as much to index as 700 short notes.

`search_docs` ranks by words alone, as without semantic search, in these cases:

- **No semantic search**: it’s off, or the engine is older than hybrid search
- **The index is being built**: the first search after a change starts it
- **The engine runs another version**: its docs differ from those of the MCP server
- **The engine doesn’t answer**: `search_docs` asks it again a minute later

## Read the docs from programs and editors

Programs and people read the same pages:

- **Programs**: the engine serves them, with a token like its other routes. `GET /datanotes/manual/` lists them, and `GET /datanotes/manual/guides/read-and-write/read-and-filter.md` returns one page. Add `?section=compare-values-with-operators` for one section.
- **Search by meaning**: `POST /datanotes/manual/search/` takes a `query` and returns the sections closest in meaning, with `ready: false` while the engine builds the index. Programs that use `datanotes/mcp` pass a `client` to `callDocsTool` to search like `datanotes mcp`.
- **People and editors**: the files themselves, in `node_modules/datanotes/dist/docs/`.

```bash
curl -H "Authorization: Bearer your_token" \
  http://127.0.0.1:27150/datanotes/manual/start/quick-start.md
```

A program ranks the sections by meaning with the same [client](/develop/client/):

```ts
const ranked = await db.post("/manual/search/", {
  query: "undo what an agent did",
});
```

In a checkout of the repository, build the docs first with `cd docs && npm ci && npm run build`, which copies the pages to `dist/docs/`. Until then, the tools answer with that command.
