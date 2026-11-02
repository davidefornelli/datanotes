// The engine settings screen's logic (plan P8b, contract 3.0.4): which group a setting belongs to,
// how its value becomes an input and an input a value, the draft of the user's edits, the header
// patch, the confirmation a risky change needs, the rebase after a conflict and a new owner token.
// Pure: no DOM at import time. It checks types only: ranges and the rest are the engine's to judge.

/** One setting as POST /datanotes/settings/ shows it (contract 3.0.4). */
export interface SettingView {
  name: string;
  type: "boolean" | "integer" | "number" | "string" | "enum" | "string_list" | "string_map";
  value?: unknown;
  default_value?: unknown;
  changed: boolean;
  expected: string;
  values?: string[];
  minimum?: number;
  maximum?: number;
  applies: "live" | "restart";
  editable: boolean;
  change_with?: string;
  restart_pending: boolean;
  overridden_by?: string;
  write_only?: true;
  redacted?: true;
  sends_data?: true;
  warning?: string;
}

/** The answer of POST /datanotes/settings/. */
export interface SettingsAnswer {
  settings_file: string | null;
  settings_version: string;
  file_changed_on_disk: boolean;
  restart_pending: string[];
  settings: SettingView[];
}

/** The 200 answer of POST /datanotes/settings/update/. */
export interface SettingsUpdateAnswer {
  ok: true;
  dry_run: boolean;
  settings_version: string;
  changed: string[];
  applied_now: string[];
  after_restart: string[];
  restart_pending: string[];
  follow_ups: { setting: string; description: string }[];
  migration_id?: string;
  settings: SettingView[];
}

/** Setting name -> the value to send (null: back to the default). Only the user's edits. */
export type Draft = Record<string, unknown>;

export type GroupName = "Journal and logs" | "Telemetry" | "Automatic work" | "Semantic search" | "Performance" | "Vault" | "HTTP server" | "Store";

/** The groups, in display order. */
export const GROUPS: readonly GroupName[] = ["Journal and logs", "Telemetry", "Automatic work", "Semantic search", "Performance", "Vault", "HTTP server", "Store"];

const EXACT: Record<string, GroupName> = {
  journalRetentionDays: "Journal and logs",
  fileLogEnabled: "Journal and logs",
  logRetentionDays: "Journal and logs",
  autoRecompute: "Automatic work",
  autoPack: "Automatic work",
  repairLinksOnHandMove: "Automatic work",
  readCacheMaxBytes: "Performance",
  vaultIndexEnabled: "Vault",
  tableKey: "Vault",
  transactionLogFormat: "Store",
};

const PREFIXES: [string, GroupName][] = [
  ["telemetry", "Telemetry"],
  ["semantic", "Semantic search"],
  ["writePriority", "Performance"],
  ["http", "HTTP server"],
  ["store", "Store"],
];

/** The group a setting is shown in; a name this page does not know (added later) goes to "Store". */
export function groupOf(name: string): GroupName {
  const exact = EXACT[name];
  if (exact) return exact;
  for (const [prefix, group] of PREFIXES) if (name.startsWith(prefix)) return group;
  return "Store";
}

/** The setting's current value as the input shows it. */
export function inputOf(v: SettingView): string | boolean {
  switch (v.type) {
    case "boolean":
      return v.value === true;
    case "integer":
    case "number":
      return String(v.value);
    case "string":
    case "enum":
      return typeof v.value === "string" ? v.value : "";
    case "string_list":
      return Array.isArray(v.value) ? v.value.map(String).join("\n") : "";
    default:
      return "";
  }
}

/** An input as a value of the setting's JSON type, or why it is not one. */
export function parseInput(v: SettingView, raw: string | boolean): { value?: unknown; error?: string } {
  if (v.write_only || v.type === "string_map") return { error: "use the editor of this setting" };
  if (v.type === "boolean") {
    if (typeof raw === "boolean") return { value: raw };
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    return { error: "choose true or false" };
  }
  const text = typeof raw === "string" ? raw : String(raw);
  switch (v.type) {
    case "integer": {
      const t = text.trim();
      return /^-?\d+$/.test(t) ? { value: Number(t) } : { error: "a whole number" };
    }
    case "number": {
      const t = text.trim();
      const n = Number(t);
      return t !== "" && Number.isFinite(n) ? { value: n } : { error: "a number" };
    }
    case "string_list":
      return {
        value: text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      };
    default:
      return { value: text };
  }
}

/** A new draft with the edit; an edit back to the shown value is no edit (a URL without its credentials too). */
export function setDraft(draft: Draft, v: SettingView, value: unknown): Draft {
  const next: Draft = { ...draft };
  if (JSON.stringify(value) === JSON.stringify(v.value)) delete next[v.name];
  else next[v.name] = value;
  return next;
}

/** One edit of the headers editor: a new or replaced value, or a removal. */
export interface HeaderEdit {
  name: string;
  value?: string;
  remove?: boolean;
}

/** The telemetryHeaders patch of the edits ({"X-Key": "v"} sets, {"X-Key": null} removes). */
export function headerPatch(current: Record<string, string>, edits: HeaderEdit[]): { patch: Record<string, string | null>; errors: string[] } {
  const patch: Record<string, string | null> = {};
  const errors: string[] = [];
  for (const e of edits) {
    const name = e.name.trim();
    if (name === "") {
      errors.push("type the header's name");
      continue;
    }
    if (e.remove) {
      if (Object.prototype.hasOwnProperty.call(current, name)) patch[name] = null;
      continue;
    }
    if (e.value === undefined) continue;
    if (e.value === "") {
      errors.push("type the header's value");
      continue;
    }
    patch[name] = e.value;
  }
  return { patch, errors };
}

/** One row of the headers editor: an existing header (its name is fixed) or a new one. */
export interface HeaderRow {
  name: string;
  value: string;
  remove: boolean;
  existing: boolean;
}

/**
 * The headers editor's rows from the header names the engine shows and the draft's patch, for an
 * editor mounted again after a reload or a restart: a removed header is marked, a replaced one gets
 * its typed value back (and is in `replacing`, so its input shows), a new one comes back as a new
 * row. A patch that is not an object gives the plain rows.
 */
export function headerRows(current: Record<string, string>, patch: unknown): { rows: HeaderRow[]; replacing: string[] } {
  const p = typeof patch === "object" && patch !== null && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const rows: HeaderRow[] = [];
  const replacing: string[] = [];
  for (const name of Object.keys(current)) {
    const edit = p[name];
    if (edit === null) rows.push({ name, value: "", remove: true, existing: true });
    else if (typeof edit === "string") {
      rows.push({ name, value: edit, remove: false, existing: true });
      replacing.push(name);
    } else rows.push({ name, value: "", remove: false, existing: true });
  }
  for (const name of Object.keys(p)) {
    const edit = p[name];
    if (!Object.prototype.hasOwnProperty.call(current, name) && typeof edit === "string") rows.push({ name, value: edit, remove: false, existing: false });
  }
  return { rows, replacing };
}

/** What Save asks before it saves: the warnings of the changed settings, and the host to type. */
export function confirmationFor(views: SettingView[], draft: Draft): { warnings: string[]; requireText: string | null } {
  const warnings: string[] = [];
  let requireText: string | null = null;
  for (const v of views) {
    if (!Object.prototype.hasOwnProperty.call(draft, v.name)) continue;
    if (v.warning) warnings.push(`${v.name}: ${v.warning}`);
    const value = draft[v.name];
    if (requireText === null && v.sends_data && typeof value === "string" && value !== "") requireText = hostOf(value);
  }
  return { warnings, requireText };
}

/** The host of an address: a URL's hostname, the host of git over SSH (git@host:path), else the text. */
export function hostOf(address: string): string {
  try {
    const host = new URL(address).hostname;
    if (host) return host;
  } catch {
    // not a URL: try git over SSH
  }
  const m = /^[^@\s]+@([^:\s]+):/.exec(address);
  return m?.[1] ?? address;
}

/** After a stale-version conflict: keep the edits of settings nobody changed meanwhile. */
export function rebase(before: SettingView[], after: SettingView[], draft: Draft): { draft: Draft; dropped: string[] } {
  const next: Draft = {};
  const dropped: string[] = [];
  const key = (v: SettingView) => JSON.stringify(v.write_only ? [v.changed] : [v.value, v.changed]);
  const order = [...before.map((v) => v.name), ...Object.keys(draft)];
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name) || !Object.prototype.hasOwnProperty.call(draft, name)) continue;
    seen.add(name);
    const b = before.find((v) => v.name === name);
    const a = after.find((v) => v.name === name);
    if (!a || !b || key(a) !== key(b)) dropped.push(name);
    else next[name] = draft[name];
  }
  return { draft: next, dropped };
}

/** A 400 answer's refused values by setting name; anything else gives {}. */
export function refusedByName(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const refused = typeof json === "object" && json !== null ? (json as { refused?: unknown }).refused : undefined;
  if (!Array.isArray(refused)) return out;
  for (const r of refused) {
    if (typeof r !== "object" || r === null) continue;
    const { setting, error } = r as { setting?: unknown; error?: unknown };
    if (typeof setting === "string" && typeof error === "string") out[setting] = error;
  }
  return out;
}

/** A new owner token: 24 random bytes as 48 lowercase hex characters (getRandomValues works without HTTPS). */
export function newOwnerToken(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = "";
  for (const b of Array.from(random(24))) out += (b < 16 ? "0" : "") + b.toString(16);
  return out;
}
