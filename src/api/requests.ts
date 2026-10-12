/**
 * The HTTP request behind each operation of the catalogue (`catalog.ts`): every one is
 * `POST /datanotes/operations/<name>/`, its JSON body the operation's arguments as they are (the
 * same names an agent passes to the MCP tool), without the ones left out (null or undefined).
 */

import { OPERATIONS } from "./catalog.js";
import { guidedText, unknownTool, type Guidance } from "./guidance.js";

type Args = Record<string, unknown>;

/** Arguments no request can be built from; `message` ends with how to fix them. */
export class OperationInputError extends Error {
  override readonly name = "OperationInputError";
  constructor(message: string, guidance: Guidance) {
    super(guidedText(message, guidance));
  }
}

/** Drop undefined / null values (optional arguments not given). */
function compact(o: Args): Args {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

export const ROUTE_PREFIX = "/datanotes";

/** The operations of the catalogue, by name. */
export const CALLABLE_OPERATIONS: ReadonlySet<string> = new Set(OPERATIONS.map((o) => o.name));

/** The route of an operation, without the prefix: `/operations/<name>/`. */
export function operationRoute(name: string): string {
  return `/operations/${name}/`;
}

export interface OperationRequest {
  method: "POST";
  /** Path from the server root. */
  path: string;
  body: Args;
}

/** The request for an operation and its arguments; throws OperationInputError for an unknown operation. */
export function operationRequest(name: string, args: Args = {}): OperationRequest {
  if (!CALLABLE_OPERATIONS.has(name)) throw new OperationInputError(`unknown operation: ${name}`, unknownTool(name, [...CALLABLE_OPERATIONS]));
  return { method: "POST", path: `${ROUTE_PREFIX}${operationRoute(name)}`, body: compact(args) };
}
