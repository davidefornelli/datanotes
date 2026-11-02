// The browser's app state: who is signed in, the API client every screen uses, the catalog cache,
// the change bus, view-as (G5) and the toasts. The token lives here in memory, and in the tab's
// storage (or the remembered one) through lib/auth.ts; it never goes into a URL.
//
// A 401 anywhere (AuthRefused) signs out: useApp().api wraps op() and route() to do that. plainApi
// is the same client without the wrapper, for the one caller that must see the 401 itself (the
// engine settings screen's restart waiter, P8b).

import { createContext, type ComponentChildren, type JSX } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiClient, AuthRefused, EngineUnreachable, viewAsGone, type ApiAnswer, type ApiOptions } from "./lib/api";
import { clearToken, loadToken, newUiSession, saveToken, storages } from "./lib/auth";
import { CatalogCache } from "./lib/catalog";
import { ChangeBus, VIEW_AS_WAIT_MS, WAIT_MS, type WireEvent } from "./lib/changes";
import { navigate, parseHash, type Route } from "./lib/router";

export interface AppState {
  /** The client of every screen, with viewAs applied; a 401 signs out. */
  api: ApiClient;
  /** The same client without the sign-out wrapper (only P8b's restart waiter). */
  plainApi: ApiClient;
  identity: { auth: string; version: string };
  isOwner: boolean;
  viewAs: string | null;
  setViewAs(name: string | null): void;
  readOnly: boolean;
  /** One per (token, viewAs): never shared between them. */
  catalog: CatalogCache;
  /** Restarted when viewAs changes. */
  bus: ChangeBus;
  toast(t: { text: string; kind?: "ok" | "error" | "info"; undo?: string }): void;
  signOut(reason?: string): void;
}

/** The sign-in state the login page and the app root read (before there is an AppState). */
export interface SessionState {
  phase: "loading" | "signed-out" | "ready" | "unreachable";
  /** Why the engine could not be reached. */
  message: string;
  version: string;
  /** Checks a token with the engine and signs in with it: "ok", "refused" or the unreachable message. */
  signIn(token: string, remember: boolean): Promise<"ok" | "refused" | string>;
  retry(): void;
}

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error" | "info";
  undo?: string;
}

/** A client whose 401 signs out before it reaches the screen. */
class SigningOutClient extends ApiClient {
  private readonly onRefused: () => void;
  private readonly onViewAsGone: (() => void) | undefined;
  constructor(o: ApiOptions, onRefused: () => void, onViewAsGone?: () => void) {
    super(o);
    this.onRefused = onRefused;
    this.onViewAsGone = onViewAsGone;
  }
  private guard<T>(p: Promise<ApiAnswer<T>>): Promise<ApiAnswer<T>> {
    return p.then(
      (a) => {
        // the viewed token was deleted or renamed: back to the owner's own view
        if (this.onViewAsGone && viewAsGone(a, this.viewAs)) this.onViewAsGone();
        return a;
      },
      (e: unknown) => {
        if (e instanceof AuthRefused) this.onRefused();
        throw e;
      },
    );
  }
  override op<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiAnswer<T>> {
    return this.guard(super.op<T>(name, args, signal));
  }
  override route<T = Record<string, unknown>>(route: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiAnswer<T>> {
    return this.guard(super.route<T>(route, body, signal));
  }
  override withViewAs(name: string | null): ApiClient {
    return new SigningOutClient({ ...this.options, viewAs: name }, this.onRefused, this.onViewAsGone);
  }
}

const AppContext = createContext<AppState | null>(null);
const SessionContext = createContext<SessionState | null>(null);
const ToastContext = createContext<{ toasts: Toast[]; dismiss(id: number): void }>({ toasts: [], dismiss: () => {} });

export function useApp(): AppState {
  const s = useContext(AppContext);
  if (!s) throw new Error("useApp() is used outside a signed-in AppProvider");
  return s;
}

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession() is used outside AppProvider");
  return s;
}

export function useToasts(): { toasts: Toast[]; dismiss(id: number): void } {
  return useContext(ToastContext);
}

/** The current route; re-renders on hashchange. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

type ChangePage = { events: WireEvent[]; last: number; head: number; gap?: boolean };

interface Signed {
  token: string;
  auth: string;
  version: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AppProvider(props: { children: ComponentChildren }): JSX.Element {
  const uiSession = useMemo(() => newUiSession(), []);
  const [phase, setPhase] = useState<SessionState["phase"]>("loading");
  const [message, setMessage] = useState("");
  const [version, setVersion] = useState("");
  const [signed, setSigned] = useState<Signed | null>(null);
  const [viewAs, setViewAsState] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [attempt, setAttempt] = useState(0);
  const toastId = useRef(0);

  const probe = useCallback(
    (token: string) =>
      new ApiClient({ token, actor: { harness: "datanotes-ui", session: uiSession } }).identity(),
    [uiSession],
  );

  const signOut = useCallback((reason?: string) => {
    const { session, local } = storages();
    clearToken(session, local);
    setSigned(null);
    setViewAsState(null);
    setToasts((list) => list.filter((x) => !x.undo));
    setPhase("signed-out");
    navigate("login", {}, reason ? { reason } : {});
  }, []);

  // At page load: the saved token, checked with the engine.
  useEffect(() => {
    let live = true;
    const { session, local } = storages();
    const saved = loadToken(session, local);
    setPhase("loading");
    probe(saved?.token ?? "")
      .then((id) => {
        if (!live) return;
        setVersion(id.version);
        if (saved && id.authenticated && id.auth) {
          setSigned({ token: saved.token, auth: id.auth, version: id.version });
          setPhase("ready");
        } else if (saved) {
          signOut("refused");
        } else {
          setPhase("signed-out");
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        setMessage(e instanceof Error ? e.message : String(e));
        setPhase("unreachable");
      });
    return () => {
      live = false;
    };
  }, [attempt, probe, signOut]);

  const signIn = useCallback(
    async (token: string, remember: boolean): Promise<"ok" | "refused" | string> => {
      try {
        const id = await probe(token);
        setVersion(id.version);
        if (!id.authenticated || !id.auth) return "refused";
        const { session, local } = storages();
        saveToken(session, local, token, remember);
        setViewAsState(null);
        setToasts((list) => list.filter((x) => !x.undo));
        setSigned({ token, auth: id.auth, version: id.version });
        setPhase("ready");
        return "ok";
      } catch (e) {
        if (e instanceof EngineUnreachable) return e.message;
        return e instanceof Error ? e.message : String(e);
      }
    },
    [probe],
  );

  const toast = useCallback((t: { text: string; kind?: "ok" | "error" | "info"; undo?: string }) => {
    const id = ++toastId.current;
    const entry: Toast = { id, text: t.text, kind: t.kind ?? "ok" };
    if (t.undo) entry.undo = t.undo;
    setToasts((list) => [...list.slice(-4), entry]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.undo ? 12_000 : 6_000);
  }, []);
  // the viewed token was deleted or renamed: once per name, back to the owner's view, with a toast
  const goneFor = useRef<string | null>(null);
  const viewAsGoneFor = useCallback(
    (name: string) => {
      if (goneFor.current === name) return;
      goneFor.current = name;
      setViewAsState((cur) => (cur === name ? null : cur));
      toast({ text: `Token ${name} no longer exists: you are back to your own view.`, kind: "info" });
    },
    [toast],
  );
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((x) => x.id !== id)), []);

  const isOwner = signed?.auth === "owner";
  // an Undo toast belongs to the client that made the write: it goes when the client changes
  const setViewAs = useCallback(
    (name: string | null) => {
      goneFor.current = null;
      setViewAsState(isOwner ? name : null);
      setToasts((list) => list.filter((x) => !x.undo));
    },
    [isOwner],
  );

  // One client, catalog and bus per (token, viewAs).
  const clients = useMemo(() => {
    if (!signed) return null;
    const options: ApiOptions = {
      token: signed.token,
      actor: { harness: "datanotes-ui", harness_version: signed.version, session: uiSession },
      viewAs,
    };
    const api = new SigningOutClient(options, () => signOut("refused"), viewAs === null ? undefined : () => viewAsGoneFor(viewAs));
    const plainApi = new ApiClient(options);
    const catalog = new CatalogCache((name, args) => api.op(name, args));
    const bus = new ChangeBus({
      list: (args, signal) => api.op<ChangePage>("list_changes", args, signal),
      sleep,
      visible: () => document.visibilityState === "visible",
      onAuthRefused: () => signOut("refused"),
      waitMs: viewAs === null ? WAIT_MS : VIEW_AS_WAIT_MS,
    });
    return { api, plainApi, catalog, bus };
  }, [signed, viewAs, uiSession, signOut, viewAsGoneFor]);

  // The bus runs only while signed in; a metastore event reloads the tree.
  useEffect(() => {
    if (!clients) return;
    const off = clients.bus.subscribe(() => void clients.catalog.refresh().catch(() => {}), { kinds: ["metastore"] });
    clients.bus.start();
    return () => {
      off();
      clients.bus.stop();
    };
  }, [clients]);

  const app = useMemo<AppState | null>(() => {
    if (!signed || !clients) return null;
    return {
      ...clients,
      identity: { auth: signed.auth, version: signed.version },
      isOwner,
      viewAs,
      setViewAs,
      readOnly: viewAs !== null,
      toast,
      signOut,
    };
  }, [signed, clients, isOwner, viewAs, setViewAs, toast, signOut]);

  const sessionState = useMemo<SessionState>(
    () => ({ phase, message, version, signIn, retry: () => setAttempt((n) => n + 1) }),
    [phase, message, version, signIn],
  );
  const toastState = useMemo(() => ({ toasts, dismiss }), [toasts, dismiss]);

  return (
    <SessionContext.Provider value={sessionState}>
      <ToastContext.Provider value={toastState}>
        <AppContext.Provider value={phase === "ready" ? app : null}>{props.children}</AppContext.Provider>
      </ToastContext.Provider>
    </SessionContext.Provider>
  );
}
