/**
 * Webhooks: the change feed pushed to URLs, for services that would rather be called than poll.
 *
 * Each webhook (a "connector") is kept in the engine's store (`store:webhooks.json`) with its
 * filter (tables, ops, columns, exclude_actor, where), its cursor (last sequence number delivered), status
 * and last error. Delivery: batches of up to 100 events, in order, as
 *
 *   POST <url>   { "webhook": "<id>", "events": [ … ], "last": <seq> }
 *   X-Datanotes-Signature: sha256=<hex HMAC-SHA256 of the body with the webhook's secret>
 *   X-Datanotes-Delivery: <last seq>
 *
 * A 2xx answer moves the cursor; anything else is retried with backoff (5 s doubling, at most
 * 10 min), so a receiver that is down gets everything when it comes back (within the feed's
 * retention; past it, an event `{"gap": true}` tells it to re-read the tables).
 *
 * Delivery is at least once: the cursors are saved at most once a second ({@link CURSOR_SAVE_MS})
 * and when the engine stops, so after a crash a receiver may get again the batches of the last
 * second (`X-Datanotes-Delivery`, the last sequence number of a batch, tells them apart).
 * Creating, deleting, enabling or disabling a webhook is saved at once.
 */

import type { App } from "../core/host";
import { wireEvent, type ChangeFeed, type ChangeOp } from "../core/change-feed";
import type { DatanotesSettings } from "../core/settings";
import { storePath, storeRead, storeWrite } from "../core/store";
import { telemetry } from "../core/telemetry";
import { messageOf } from "../core/message";
import { withSpan } from "../core/tracing";
import type { AttrValue } from "../core/telemetry";

/** A delivery's CLIENT span attributes: where it goes (no query, no credentials) and what. */
export function webhookAttributes(h: { id: string; url: string }, events: number): Record<string, AttrValue> {
  let u: URL | null = null;
  try {
    u = new URL(h.url);
  } catch {
    u = null;
  }
  return {
    "http.request.method": "POST",
    "url.full": u ? `${u.protocol}//${u.host}${u.pathname}` : undefined,
    "server.address": u?.hostname,
    "server.port": u ? Number(u.port || (u.protocol === "https:" ? 443 : 80)) : undefined,
    "peer.service": "webhook",
    "datanotes.webhook.id": h.id,
    "datanotes.events": events,
  };
}

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  tables?: string[];
  ops?: ChangeOp[];
  columns?: string[];
  excludeActor?: string;
  where?: Record<string, unknown>;
  enabled: boolean;
  /** Last sequence number delivered (or skipped by the filter). */
  cursor: number;
  createdAt: string;
  lastDelivery?: string;
  lastError?: string;
  failures: number;
}

/** A webhook as callers see it: snake_case, no secret (webhooks.json keeps its stored form). */
export interface PublicWebhook {
  id: string;
  url: string;
  tables?: string[];
  kinds?: string[];
  columns?: string[];
  exclude_actor?: string;
  where?: Record<string, unknown>;
  enabled: boolean;
  cursor: number;
  created_at: string;
  last_delivery?: string;
  last_error?: string;
  failures: number;
  status: "ok" | "failing" | "disabled";
}

export type Post = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

const defaultPost: Post = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", body, headers });
  return { status: r.status };
};

const BATCH = 100;
const WAIT_MS = 20_000;
/** The cursors moved by deliveries are saved at most this often (and when the engine stops). */
export const CURSOR_SAVE_MS = 1000;
const MAX_BACKOFF_MS = 10 * 60_000;

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function publicView(w: Webhook): PublicWebhook {
  return {
    id: w.id,
    url: w.url,
    ...(w.tables !== undefined ? { tables: w.tables } : {}),
    ...(w.ops !== undefined ? { kinds: w.ops.map((o) => (o === "schema" ? "metastore" : o)) } : {}),
    ...(w.columns !== undefined ? { columns: w.columns } : {}),
    ...(w.excludeActor !== undefined ? { exclude_actor: w.excludeActor } : {}),
    ...(w.where !== undefined ? { where: w.where } : {}),
    enabled: w.enabled,
    cursor: w.cursor,
    created_at: w.createdAt,
    ...(w.lastDelivery !== undefined ? { last_delivery: w.lastDelivery } : {}),
    ...(w.lastError !== undefined ? { last_error: w.lastError } : {}),
    failures: w.failures,
    status: !w.enabled ? "disabled" : w.failures > 0 ? "failing" : "ok",
  };
}

export class WebhookDispatcher {
  private hooks: Webhook[] = [];
  private loops = new Map<string, Promise<void>>();
  private running = false;
  private saving: Promise<void> = Promise.resolve();
  /** A save of the moved cursors, waiting for its turn (at most one a second). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSave = 0;
  /** Wakes a backoff sleep early (stop, delete). */
  private wake = new Map<string, () => void>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
    private readonly feed: () => ChangeFeed | null,
    private readonly post: Post = defaultPost,
    private readonly backoffBaseMs = 5000,
  ) {}

  private file(): string {
    return storePath("webhooks.json");
  }

  async start(): Promise<void> {
    try {
      const text = await storeRead(this.app, this.file());
      this.hooks = text ? (JSON.parse(text) as Webhook[]) : [];
    } catch {
      this.hooks = [];
    }
    this.running = true;
    for (const h of this.hooks) this.spawn(h);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const w of this.wake.values()) w();
    await Promise.race([Promise.all(this.loops.values()), new Promise((r) => setTimeout(r, 1000))]);
    // the cursors moved since the last save
    if (this.saveTimer) await this.save();
    await this.saving;
  }

  list(): PublicWebhook[] {
    return this.hooks.map(publicView);
  }

  async create(input: { url: string; tables?: string[]; ops?: ChangeOp[]; columns?: string[]; excludeActor?: string; where?: Record<string, unknown>; since?: number }): Promise<PublicWebhook & { secret: string }> {
    if (!/^https?:\/\//i.test(input.url)) throw new Error(`"url" must be an http(s) URL`);
    const feed = this.feed();
    const hook: Webhook = {
      id: `wh_${randomHex(6)}`,
      url: input.url,
      secret: randomHex(24),
      ...(input.tables?.length ? { tables: input.tables } : {}),
      ...(input.ops?.length ? { ops: input.ops } : {}),
      ...(input.columns?.length ? { columns: input.columns } : {}),
      ...(input.excludeActor ? { excludeActor: input.excludeActor } : {}),
      ...(input.where && Object.keys(input.where).length ? { where: input.where } : {}),
      enabled: true,
      cursor: input.since ?? feed?.lastSeq ?? 0,
      createdAt: new Date().toISOString(),
      failures: 0,
    };
    this.hooks.push(hook);
    await this.save();
    if (this.running) this.spawn(hook);
    return { ...publicView(hook), secret: hook.secret };
  }

  async remove(id: string): Promise<boolean> {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((h) => h.id !== id);
    this.wake.get(id)?.();
    if (this.hooks.length === before) return false;
    await this.save();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PublicWebhook | null> {
    const h = this.hooks.find((x) => x.id === id);
    if (!h) return null;
    h.enabled = enabled;
    if (enabled) h.failures = 0;
    await this.save();
    if (enabled && this.running && !this.loops.has(id)) this.spawn(h);
    this.wake.get(id)?.();
    return publicView(h);
  }

  /** Save the webhooks now (with every cursor as it is). */
  private save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.lastSave = Date.now();
    this.saving = this.saving.then(() => storeWrite(this.app, this.file(), `${JSON.stringify(this.hooks, null, 2)}\n`)).catch(() => undefined);
    return this.saving;
  }

  /** A cursor or a delivery's status moved: saved within {@link CURSOR_SAVE_MS} (with the others moved meanwhile). */
  private saveSoon(): void {
    if (this.saveTimer) return;
    const wait = Math.max(0, this.lastSave + CURSOR_SAVE_MS - Date.now());
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, wait);
    this.saveTimer.unref?.();
  }

  private alive(h: Webhook): boolean {
    return this.running && h.enabled && this.hooks.includes(h);
  }

  private sleep(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake.delete(id);
        resolve();
      }
      this.wake.set(id, done);
    });
  }

  private spawn(h: Webhook): void {
    if (this.loops.has(h.id) || !h.enabled) return;
    const loop = this.deliver(h).finally(() => this.loops.delete(h.id));
    this.loops.set(h.id, loop);
  }

  /** Deliver `h`'s events in order until stopped, disabled or deleted. */
  private async deliver(h: Webhook): Promise<void> {
    while (this.alive(h)) {
      const feed = this.feed();
      if (!feed) {
        await this.sleep(h.id, 1000);
        continue;
      }
      const q = { since: h.cursor, limit: BATCH, ...(h.tables ? { tables: h.tables } : {}), ...(h.ops ? { ops: h.ops } : {}), ...(h.columns ? { columns: h.columns } : {}), ...(h.excludeActor ? { excludeActor: h.excludeActor } : {}), ...(h.where ? { where: h.where } : {}) };
      const page = await feed.wait(q, WAIT_MS);
      if (!this.alive(h)) return;
      if (page.events.length === 0 && !page.gap) {
        if (page.last !== h.cursor) {
          h.cursor = page.last; // events filtered out: move on
          this.saveSoon();
        }
        continue;
      }
      const body = JSON.stringify({ webhook: h.id, events: page.events.map(wireEvent), last: page.last, ...(page.gap ? { gap: true, since: h.cursor } : {}) });
      let ok = false;
      let error = "";
      // each delivery is a trace of its own (the loop outlives the request that created the webhook)
      await withSpan("POST", { kind: "client", newTrace: true, attributes: webhookAttributes(h, page.events.length) }, async (span) => {
        try {
          const r = await this.post(h.url, body, {
            "Content-Type": "application/json",
            "X-Datanotes-Signature": `sha256=${await hmacHex(h.secret, body)}`,
            "X-Datanotes-Delivery": String(page.last),
          });
          span.setAttribute("http.response.status_code", r.status);
          ok = r.status >= 200 && r.status < 300;
          if (!ok) {
            error = `HTTP ${r.status}`;
            span.setAttribute("error.type", String(r.status)).setStatus("error", error);
          }
        } catch (e) {
          error = messageOf(e);
          span.recordException(e);
        }
      });
      if (ok) {
        h.cursor = page.last;
        h.lastDelivery = new Date().toISOString();
        h.failures = 0;
        delete h.lastError;
        this.saveSoon();
        continue;
      }
      h.failures += 1;
      h.lastError = error.slice(0, 300);
      this.saveSoon();
      if (h.failures === 1 || h.failures % 10 === 0) telemetry().log("WARN", "datanotes webhook delivery failed", { webhook: h.id, url: h.url, failures: h.failures, error: h.lastError });
      await this.sleep(h.id, Math.min(this.backoffBaseMs * 2 ** (h.failures - 1), MAX_BACKOFF_MS));
    }
  }
}
