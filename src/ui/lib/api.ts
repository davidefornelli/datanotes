// The browser's fetch wrapper for the engine's HTTP API. It does not import src/api: that client
// pulls the whole operations catalogue into the page (D3). Every call sends the token only as
// `Authorization: Bearer`, the actor of this tab (X-Datanotes-Actor) and, while the owner views as a
// token, X-Datanotes-View-As. Pure: no DOM access at import time.

export interface ActorInfo {
  harness: string;
  harness_version?: string;
  session: string;
}

/** An answer of the engine; `ok` is true for a 2xx status. */
export interface ApiAnswer<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  json: T;
}

export interface ErrorBody {
  error: string;
  hint?: string;
  docs?: string;
}

/** 401: the token is wrong, rotated or deleted. */
export class AuthRefused extends Error {
  constructor(message = "The engine refused the token (HTTP 401).") {
    super(message);
    this.name = "AuthRefused";
  }
}

/** The engine does not answer: fetch rejected, 502, 504, or a 503 that is not the engine's own. */
export class EngineUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnreachable";
  }
}

export interface ApiOptions {
  token: string;
  actor: ActorInfo;
  viewAs?: string | null;
  /** The engine's origin; "" (the default) is the page's own. */
  base?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ApiClient {
  readonly viewAs: string | null;
  protected readonly options: ApiOptions;
  private doc: Promise<Record<string, any>> | null = null;

  constructor(o: ApiOptions) {
    this.options = o;
    this.viewAs = o.viewAs ?? null;
  }

  private get base(): string {
    return this.options.base ?? "";
  }

  private origin(): string {
    if (this.base) return this.base;
    const loc = (globalThis as { location?: { origin?: string } }).location;
    return loc?.origin ?? "this address";
  }

  private unreachable(detail: string): EngineUnreachable {
    return new EngineUnreachable(`The engine does not answer at ${this.origin()}: ${detail}`);
  }

  private async send<T>(url: string, init: RequestInit): Promise<ApiAnswer<T>> {
    const doFetch = this.options.fetchImpl ?? ((u: string, i: RequestInit) => globalThis.fetch(u, i));
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, init);
      if (res.status === 401) throw new AuthRefused();
      text = await res.text();
    } catch (e) {
      if (isAbort(e) || e instanceof AuthRefused) throw e;
      throw this.unreachable(messageOf(e));
    }
    const status = res.status;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: `HTTP ${status}: the answer is not JSON` };
    }
    const engineError = typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string";
    if (status === 502 || status === 504 || (status === 503 && !engineError)) throw this.unreachable(`HTTP ${status}`);
    return { status, ok: status >= 200 && status < 300, json: json as T };
  }

  private post<T>(path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<ApiAnswer<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      "Content-Type": "application/json",
      "X-Datanotes-Actor": JSON.stringify(this.options.actor),
    };
    if (this.viewAs) headers["X-Datanotes-View-As"] = this.viewAs;
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body ?? {}) };
    if (signal) init.signal = signal;
    return this.send<T>(`${this.base}${path}`, init);
  }

  /** POST /datanotes/operations/<name>/ */
  op<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiAnswer<T>> {
    return this.post<T>(`/datanotes/operations/${encodeURIComponent(name)}/`, args, signal);
  }

  /** POST /datanotes<route>: route("/tokens/") calls /datanotes/tokens/. */
  route<T = Record<string, unknown>>(route: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiAnswer<T>> {
    return this.post<T>(`/datanotes${route.startsWith("/") ? route : `/${route}`}`, body, signal);
  }

  /** GET / with the token only (none when the token is empty): who the engine says the token is. */
  async identity(): Promise<{ authenticated: boolean; auth: string | null; version: string }> {
    const headers: Record<string, string> = {};
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const a = await this.send<Record<string, unknown>>(`${this.base}/`, { method: "GET", headers });
    const j = a.json;
    return {
      authenticated: a.ok && j.authenticated === true,
      auth: typeof j.auth === "string" ? j.auth : null,
      version: typeof j.version === "string" ? j.version : "",
    };
  }

  /** GET /datanotes/openapi.json, without headers; cached per client (a failure is not cached). */
  openapi(): Promise<Record<string, any>> {
    if (!this.doc) {
      this.doc = this.send<Record<string, any>>(`${this.base}/datanotes/openapi.json`, { method: "GET" }).then((a) => {
        if (!a.ok) throw new Error(`The API description did not load (HTTP ${a.status}).`);
        return a.json;
      });
      this.doc.catch(() => {
        this.doc = null;
      });
    }
    return this.doc;
  }

  /** The same client (token, actor, origin) viewing as another token, or as itself with null. */
  withViewAs(name: string | null): ApiClient {
    return new ApiClient({ ...this.options, viewAs: name });
  }
}

/** Whether an answer is the engine's refusal of a view-as name that no token has any more (deleted or renamed). */
export function viewAsGone(a: ApiAnswer<unknown>, viewAs: string | null): boolean {
  if (viewAs === null || a.status !== 400) return false;
  const json = a.json as { error?: unknown } | null;
  return json !== null && typeof json === "object" && json.error === `no token ${viewAs} to view as`;
}
