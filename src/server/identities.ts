/**
 * What agents said about themselves, by agent session: an MCP server reports the
 * model (`POST /datanotes/sessions/identify/`), and later requests of that session (header
 * `X-Datanotes-Actor` with its `session`) carry it in the journal.
 */

const MAX_IDENTITIES = 2000;

type Identity = { model?: string; harness?: string };

/** Lookups also try the first 16 characters (the session MCP servers send in the actor). */
export class SessionIdentities {
  private map = new Map<string, Identity>();

  set(key: string, info: { model?: unknown; harness?: unknown }): void {
    const clean = Object.fromEntries(Object.entries(info).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, String(v).trim().slice(0, 200)])) as Identity;
    const prev = this.map.get(key);
    this.map.delete(key);
    if (this.map.size >= MAX_IDENTITIES) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { ...prev, ...clean });
  }

  get(key: string): Identity | undefined {
    return this.map.get(key) ?? this.map.get(key.slice(0, 16));
  }
}
