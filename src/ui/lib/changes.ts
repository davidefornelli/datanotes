// The change bus: one long poll of list_changes per tab (D9), shared by every screen. EventSource
// cannot send an Authorization header, so the UI long-polls instead of reading the change stream.
// Screens subscribe with a filter and get the events that match it. Pure: the network, the clock
// and the tab's visibility are injected.

import { AuthRefused, type ApiAnswer } from "./api";

export interface WireEvent {
  seq: number;
  at: string;
  table: string | null;
  kind: string;
  op?: string;
  path: string;
  old_path?: string;
  source: "engine" | "external";
  actor?: Record<string, string>;
  migration_id?: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  violations?: unknown[];
  call?: Record<string, unknown>;
}

export type ChangeListener = (events: WireEvent[], info: { gap: boolean }) => void;

export interface ChangeFilter {
  tables?: string[];
  paths?: string[];
  kinds?: string[];
}

export interface BusDeps {
  /** list_changes; the signal aborts a long poll when the bus stops. */
  list(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ApiAnswer<{ events: WireEvent[]; last: number; head: number; gap?: boolean }>>;
  sleep(ms: number): Promise<void>;
  visible(): boolean;
  onAuthRefused(): void;
  /** How long one long poll waits, in ms (default {@link WAIT_MS}). Shorter while viewing as a token, so its deletion shows within seconds. */
  waitMs?: number;
}

export const WAIT_MS = 25_000;
/** The long poll while viewing as a token: its deletion refuses the next poll, so the page leaves view-as within about 5 s. */
export const VIEW_AS_WAIT_MS = 5_000;
export const RETRY_MS = 5_000;
export const HIDDEN_MS = 2_000;

interface Subscription {
  fn: ChangeListener;
  filter: ChangeFilter | undefined;
}

function matches(e: WireEvent, f: ChangeFilter | undefined): boolean {
  if (!f) return true;
  if (f.tables && (e.table === null || !f.tables.includes(e.table))) return false;
  if (f.paths && !f.paths.includes(e.path) && !(e.old_path !== undefined && f.paths.includes(e.old_path))) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  return true;
}

export class ChangeBus {
  private readonly deps: BusDeps;
  private readonly subs = new Set<Subscription>();
  private cursor: number | null = null;
  private active = false;
  private stopped = false;
  private inFlight: AbortController | null = null;

  constructor(deps: BusDeps) {
    this.deps = deps;
  }

  subscribe(fn: ChangeListener, filter?: ChangeFilter): () => void {
    const sub: Subscription = { fn, filter };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** Starts the loop; a second call while it runs does nothing. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    void this.loop();
  }

  /** Stops the loop and aborts the long poll under way; nothing is dispatched after it. */
  stop(): void {
    this.active = false;
    this.stopped = true;
    this.inFlight?.abort();
  }

  get running(): boolean {
    return this.active;
  }

  private async loop(): Promise<void> {
    while (this.active) await this.tick();
  }

  /** One round of the loop. */
  async tick(): Promise<void> {
    const ctl = new AbortController();
    this.inFlight = ctl;
    try {
      if (this.cursor === null) {
        const a = await this.deps.list({ since: 0, limit: 1 }, ctl.signal);
        if (a.status === 200) this.cursor = a.json.head;
        else await this.deps.sleep(RETRY_MS);
        return;
      }
      if (!this.deps.visible()) {
        await this.deps.sleep(HIDDEN_MS);
        return;
      }
      const a = await this.deps.list({ since: this.cursor, wait_ms: this.deps.waitMs ?? WAIT_MS, limit: 500 }, ctl.signal);
      if (a.status !== 200) {
        await this.deps.sleep(RETRY_MS);
        return;
      }
      this.cursor = a.json.last;
      if (!this.stopped) this.dispatch(a.json.events, a.json.gap === true);
    } catch (e) {
      if (e instanceof AuthRefused) {
        this.stop();
        this.deps.onAuthRefused();
      } else if (!this.stopped) {
        await this.deps.sleep(RETRY_MS);
      }
    } finally {
      if (this.inFlight === ctl) this.inFlight = null;
    }
  }

  private dispatch(events: WireEvent[], gap: boolean): void {
    for (const sub of [...this.subs]) {
      const mine = events.filter((e) => matches(e, sub.filter));
      if (mine.length === 0 && !gap) continue;
      try {
        sub.fn(mine, { gap });
      } catch {
        // one broken listener does not stop the others
      }
    }
  }
}
