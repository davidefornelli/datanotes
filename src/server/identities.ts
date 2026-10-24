/**
 * What agents said about themselves, by agent session: an MCP server reports the
 * model (`POST /datanotes/sessions/identify/`), and later requests of that session (header
 * `X-Datanotes-Actor` with its `session`) carry it in the journal.
 *
 * A session belongs to the credential that first reported it (`claim`): another named token may
 * not name its model nor report its tool calls. The owner may report any session.
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

  /** Who reported each session first: "owner" or a token's name, by the session's first 16 characters. */
  private owners = new Map<string, string>();

  /**
   * Claim a session for a credential ("owner" or a token's name): the first one to report it keeps
   * it. Answers the token that holds it when that is another named token, else null (claimed, or
   * the owner, who may report any session). Keyed by the first 16 characters, as lookups fall back
   * to them: a token cannot take over another's session with a longer or shorter id.
   */
  claim(key: string, who: string): string | null {
    const k = key.slice(0, 16);
    const held = this.owners.get(k);
    if (held !== undefined && held !== who && who !== "owner") return held;
    this.owners.delete(k);
    if (this.owners.size >= MAX_IDENTITIES) this.owners.delete(this.owners.keys().next().value!);
    this.owners.set(k, held ?? who);
    return null;
  }
}
