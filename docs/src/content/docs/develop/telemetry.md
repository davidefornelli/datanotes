---
title: Send logs to your observability backend
description: "Send the logs of the engine, the MCP server and the apps to any OpenTelemetry backend."
sidebar:
  label: Logs and Telemetry
  order: 7
---

Every part of Datanotes sends its logs with OpenTelemetry, the vendor-neutral standard, so any backend with an OpenTelemetry Protocol (OTLP) endpoint can receive them. This page shows how to point the engine, the Model Context Protocol (MCP) server and the apps at your backend. It also shows how to follow one agent call across all three. Datanotes has no vendor-specific code.

## What Datanotes sends and where

Datanotes sends logs only, over HTTP, to `your_endpoint/v1/logs`. It encodes them as `http/protobuf`, the OpenTelemetry default, or as `http/json`. Any OpenTelemetry Collector receives them, and so do these backends, among others:

- SigNoz
- Grafana: Alloy, Loki or Grafana Cloud
- Elastic, Datadog, Honeycomb, New Relic and Dynatrace

Datanotes sends no traces or metrics. For a backend that accepts only gRPC, put an OpenTelemetry Collector in front of it. When the collector doesn’t answer, Datanotes counts the records as lost and keeps working.

## Configure the export with environment variables

The engine, the MCP server and the apps all read the standard OpenTelemetry variables:

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector’s base address, for example `http://127.0.0.1:4318` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Or the full `…/v1/logs` address |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, with URL-encoded values: the API key or `Authorization` your backend asks for |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json` |
| `OTEL_SERVICE_NAME` | The service name; defaults to `datanotes`, `datanotes-mcp` (for `datanotes mcp`) or the app’s name |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, for example `deployment.environment=home` |
| `OTEL_SDK_DISABLED=true` or `OTEL_LOGS_EXPORTER=none` | Turns the export off |

Datanotes also reads the `…_LOGS_…` variants of the headers and protocol variables. Without an endpoint, it sends nothing.

## Configure the engine in its settings file

Instead of the variables, you can configure the engine in its settings file, `settings.json` in its store (`datanotes store path` shows where). A variable you set overrides the matching setting:

```json
{
  "telemetryEnabled": true,
  "telemetryEndpoint": "http://127.0.0.1:4318",
  "telemetryServiceName": "datanotes",
  "telemetryProtocol": "http/protobuf",
  "telemetryHeaders": {}
}
```

`telemetryHeaders` holds what your backend asks for, such as an API key or `Authorization: Bearer …`. The engine keeps it in the settings file. To keep a key out of that file, set `OTEL_EXPORTER_OTLP_HEADERS` instead.

## What the engine logs

The engine logs these events:

- Every HTTP request and operation, with the route, duration, outcome and actor
- The tool calls MCP servers report, with the tool, duration, result size in characters and tokens, client, model and session
- Refused requests
- The semantic index and git sync
- Errors

Whatever the collector does, the engine also writes its records to files in `logs/`, in its store outside the vault. The `fileLogEnabled` setting turns these files on or off, and `logRetentionDays` sets how long the engine keeps them.

## Configure the MCP server and the apps

The MCP server and the apps read the same variables, and each has its own alternative:

- **`datanotes mcp`**: the `--otlp-endpoint your_endpoint` option
- **Apps**: an `otlp` block in the app’s configuration, `{"endpoint": "http://127.0.0.1:4318", "headers": {}, "serviceName": "…"}`

## Follow one agent call across services

The engine, the MCP server and the apps log the same `session` and `tool` for each agent call. `session` is the first 16 characters of the MCP session ID. Filter by `session` in your backend to see the call in the MCP server, in the app whose tool it reached, and the writes it made in the engine.

## Send logs from your own program

`datanotes/client` exports the exporter that Datanotes uses, so your own programs can log the same way:

```ts
import { OtlpLogExporter, otlpFromEnv } from "datanotes/client";

const otlp = otlpFromEnv(process.env, { serviceName: "my-app" });
const log = otlp ? new OtlpLogExporter(otlp) : null;
log?.log("INFO", "imported films", { count: 8 });
await log?.close();
```

`otlpFromEnv` reads the variables above and returns `null` when you set no endpoint or turn the export off; the program then logs nothing. Call `close()` before the program exits to send the remaining records.
