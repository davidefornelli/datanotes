/**
 * `datanotes/client`: the catalogue of operations and a client of the Datanotes HTTP API, for
 * programs that talk to an engine (the MCP server `datanotes mcp` in src/mcp, other MCP servers,
 * apps, scripts, plugins). The engine's operations as MCP tools are in
 * `datanotes/mcp` (mcp.ts).
 */

export { OPERATIONS, type OperationDef } from "./catalog.js";
export { operationRequest, operationRoute, CALLABLE_OPERATIONS, OperationInputError, ROUTE_PREFIX, type OperationRequest } from "./requests.js";
export { resultOf, describeRefusal, describeBatch, type OperationResult } from "./results.js";
export { estimateTokens } from "./tokens.js";
export { argumentsOf, checkArguments, DOCS_BASE, guidanceIn, guidedText, toolDocs, type ArgumentProblem, type Guidance } from "./guidance.js";
export { OtlpLogExporter, OtlpTraceExporter, otlpFromEnv, otlpTracesFromEnv, samplerRatioFromEnv, parseOtlpHeaders, type OtlpOptions, type Severity, type AttrValue } from "./otlp.js";
export {
  Tracer,
  TraceSpan,
  parseTraceparent,
  formatTraceparent,
  traceHeaders,
  newTraceId,
  newSpanId,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  type TraceContext,
  type TracerOptions,
  type SpanRecord,
  type SpanKind,
  type SpanStatusCode,
} from "./tracing.js";
export {
  DatanotesClient,
  DatanotesError,
  fetchTransport,
  ACTOR_HEADER,
  type ActorInfo,
  type ClientOptions,
  type HttpRequest,
  type HttpResponse,
  type RecordedToolCall,
  type ToolCallRecord,
  type TraceParent,
  type Transport,
} from "./client.js";
