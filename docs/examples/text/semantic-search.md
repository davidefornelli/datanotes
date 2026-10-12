## Turn on semantic search

Turn it on in the engine’s settings file, `settings.json` in its store (`datanotes store path` shows where):

1. Stop the engine.
2. Pick a provider and a model from the [embedding providers](#choose-an-embedding-provider) table.
3. Set `semanticEnabled`, `semanticProvider` and `semanticModel` in the settings file.
4. If the provider needs an API key, [pass the key to the engine](#pass-the-api-key-to-the-engine).
5. Start the engine.

The settings below use Ollama, which keeps your notes on your computer:

```json
{
  "semanticEnabled": true,
  "semanticProvider": "ollama",
  "semanticModel": "nomic-embed-text"
}
```

Leave `semanticBaseUrl` empty to use the provider’s default address. The [settings reference](/reference/settings/) lists every key and its default.

## Choose an embedding provider

The provider decides where your note text goes. Local providers keep it on your computer; hosted ones send it over the network:

| `semanticProvider` | Where notes go | Default address | Example model |
|---|---|---|---|
| `ollama` | Stays on this computer | `http://127.0.0.1:11434` | `nomic-embed-text`, `qwen3-embedding:0.6b` |
| `lmstudio` | Stays on this computer | `http://127.0.0.1:1234/v1` | `text-embedding-nomic-embed-text-v1.5` |
| `openrouter` | OpenRouter and the model’s provider (needs an API key) | `https://openrouter.ai/api/v1` | `openai/text-embedding-3-small`, `qwen/qwen3-embedding-0.6b` |
| `openai` | OpenAI (needs an API key) | `https://api.openai.com/v1` | `text-embedding-3-small` |
| `custom` | Any OpenAI-compatible `/embeddings` API | None: set `semanticBaseUrl` | The model your API serves |

## Pass the API key to the engine

The engine never stores API keys in the settings file. Set the `DATANOTES_EMBEDDING_KEY` environment variable before you start the engine, or pass a file that holds the key:

```bash
npx -y datanotes serve --database your_database_folder \
  --embedding-key-file your_key_file
```

## Choose which notes to index

By default the engine indexes every note in the vault. Two settings narrow the scope:

- **`semanticScope`**: `"vault"` (the default) indexes every note; `"tables"` indexes only table rows
- **`semanticExclude`**: folders to leave out

The engine always skips `_archive` folders.

## How the engine builds the index

The engine splits each note into passages of at most about 1,500 characters. The splitting follows these rules:

- **First passage**: holds the title and the front matter, up to 800 characters, without the keys `id` and `table`
- **Heading sections**: each section starts a new passage
- **Long sections**: the engine splits them at paragraph boundaries
- **Limit**: 40 passages per note

The engine sends the passages to the model and stores the vectors as int8 values in `semantic/`, in its store. It updates the index 10s after edits stop, and 5s after it starts. It embeds again only the notes whose content changed. If you change the provider, the address or the model, the engine starts a new index.

## Search from agents and programs

Agents and programs use three operations. All three work through the [HTTP API](/develop/http-api/), the [JavaScript client](/develop/client/) and the [Model Context Protocol (MCP) server](/start/connect-agents/):

- **[`semantic_search`](/reference/operations/queries/#semantic_search)**: takes a `query`, with optional `tables`, `folder`, `min_score` and `limit`; returns one result per note, its best passage, best first
- **[`describe_semantic_index`](/reference/operations/auxiliary/#describe_semantic_index)**: shows the index status
- **[`sync_semantic_index`](/reference/operations/auxiliary/#sync_semantic_index)**: brings the index up to date, or rebuilds it with `rebuild: true`

This example asks for the five notes closest in meaning to a question. `db` is a [client](/develop/client/) connected to the engine:

```ts
const r = await db.call("semantic_search", {
  query: "films that scare without a single spoken word",
  limit: 5,
});
```

## Search these docs by meaning

With semantic search on, the engine also embeds the sections of these docs, in an index of their own. `search_docs` then merges its ranking by words with the engine’s ranking by meaning. [Search by words and by meaning](/guides/agents/docs-offline/#search-by-words-and-by-meaning) explains how.
