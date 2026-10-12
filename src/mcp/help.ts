/** The `datanotes mcp --help` text; its usage and options are also part of `datanotes --help`. */

export const MCP_USAGE = `  datanotes mcp --database <folder>            MCP server over stdio, on the engine running on the folder
                                               (or one it starts for the session)
  datanotes mcp --url <url> --token-file <f>   MCP server over stdio, on an engine at an address
  datanotes mcp serve [options]                MCP server over Streamable HTTP at /mcp (each agent sends its token)`;

export const MCP_OPTIONS = `Options of mcp (stdio):
  --database <folder>         the database folder (or DATANOTES_DATABASE); acts with the owner's token,
                              and stops the engine it started when the client closes
  --vault <folder>            or a vault holding the database (or DATANOTES_VAULT)
  --url <url>                 the engine's address (or DATANOTES_URL), with
  --token-file <file>         a file holding the token (or DATANOTES_TOKEN_FILE, or the token in DATANOTES_TOKEN)
                              DATANOTES_ENGINE_START_TIMEOUT_S: how long --database waits for the engine
                              it starts, in seconds (default 60; a large database starts slowly)

Options of mcp serve:
  --url <url>                 the engine (default http://127.0.0.1:27150, or DATANOTES_URL)
  --host <address>            listen address (default 127.0.0.1, or DATANOTES_MCP_HOST)
  --port <n>                  port (default 27151, or DATANOTES_MCP_PORT)

Tools of mcp (both modes; default: every tool except create_webhook and delete_webhook):
  --profile <name>            read (read-only tools), write (no schema changes, no webhooks) or
                              all (every tool, webhooks included) (or DATANOTES_MCP_PROFILE)
  --tools <names>             only these tools, separated by commas (or DATANOTES_MCP_TOOLS)
  --except <names>            none of these tools, separated by commas (or DATANOTES_MCP_EXCEPT)
  --owner-tools               also offer create_webhook and delete_webhook
                              (or DATANOTES_MCP_OWNER_TOOLS=1)

Logs of mcp (both modes):
  --otlp-endpoint <url>       export logs over OTLP/HTTP, e.g. http://127.0.0.1:4318 (or the standard
                              OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME)

Docs of mcp (both modes): the tools list_docs, read_docs and search_docs read the docs of this
version from the package (dist/docs), or from the folder in DATANOTES_DOCS_DIR; search_docs also
ranks them by meaning when the engine has semantic search on (hybrid search)`;

export function mcpHelp(version: string): string {
  return `datanotes mcp ${version}: the MCP server of Datanotes, for agents. It runs apart from the engine and
calls its HTTP API with the agent's token.

Usage:
${MCP_USAGE}

${MCP_OPTIONS}

Docs: https://datanotes.dev/start/connect-agents/`;
}
