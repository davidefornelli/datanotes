/**
 * The engine's settings over HTTP (owner only; listed in OWNER_ADMIN_ROUTES and checked again
 * here): `POST /datanotes/settings/` reads every setting of the settings file with its default,
 * its rule and whether a change applies at once or after a restart; `POST
 * /datanotes/settings/update/` changes settings, checked with the rules the engine loads the
 * settings file with (`SETTING_RULES`), guarded by `expect_version`, one change at a time, saved to
 * the settings file and journaled as `set_engine_settings`.
 *
 * Secrets are write-only: the owner token is never sent, the values of `telemetryHeaders` are
 * hidden, and the credentials inside an address are stripped, also from an address `new URL`
 * refuses. No secret leaves this module: not in
 * an answer, an error, a journal entry or a log line.
 */
import { currentActor } from "../core/actor";
import type { JournalSettingChange } from "../core/changeset";
import { guide, nameList, unknownName, type Guidance } from "../core/hints";
import { messageOf } from "../core/message";
import { checkSetting, DEFAULT_SETTINGS, RUNTIME_KEYS, SETTING_RULES, type DatanotesSettings, type EditableSettingKey } from "../core/settings";
import { FORBIDDEN_HINT, type Body, type Handler, type HandlerResponse } from "./rest";
import { tokenNameOf } from "./tokens";
import { stripLeadingUserinfo } from "../core/url-credentials";

/** One setting as the settings routes show it (contract 3.0.4 of the database browser). */
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

/** What the routes need from the engine and its host. */
export interface SettingsDeps {
  /** The one object the host saves: changed in place. */
  getSettings(): DatanotesSettings;
  saveSettings(): Promise<void>;
  /** The values this run started with. */
  running(): Partial<DatanotesSettings>;
  settingsFile(): string | null;
  fileChanged(): boolean;
  overrides(): Readonly<Record<string, string>>;
  /** Writes the journal entry; returns its migration_id. */
  journal(summary: string, settings: JournalSettingChange[]): Promise<string>;
  log(level: "INFO" | "WARN", message: string, attrs: Record<string, string>): void;
  afterChange(changed: string[]): void;
}

/**
 * A URL without its user and password: parsed when new URL reads it, else as text (an address new URL
 * refuses, such as a port over 65535); a text that is not a URL (git@host:repo.git, "") as it is.
 */
export function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return stripLeadingUserinfo(url);
  }
}

const SETTING_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof DatanotesSettings)[]).filter(
  (k): k is EditableSettingKey => !(RUNTIME_KEYS as readonly string[]).includes(k),
);
const ORDER = new Map<string, number>(Object.keys(DEFAULT_SETTINGS).map((k, i) => [k, i]));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every setting of the settings file, in its order, with its rule; secrets hidden. */
export function settingsView(s: DatanotesSettings, running: Partial<DatanotesSettings>, overrides: Readonly<Record<string, string>>): SettingView[] {
  return SETTING_KEYS.map((key) => {
    const rule = SETTING_RULES[key];
    const current: unknown = s[key];
    let value: Pick<SettingView, "value" | "default_value" | "changed" | "write_only" | "redacted">;
    if (rule.secret === "value") {
      value = { changed: current !== "", write_only: true, redacted: true };
    } else if (rule.secret === "header_values") {
      const names = Object.keys(current as Record<string, string>);
      value = {
        value: Object.fromEntries(names.map((n) => [n, "<redacted>"])),
        default_value: {},
        changed: names.length > 0,
        ...(names.length > 0 ? { redacted: true as const } : {}),
      };
    } else if (rule.secret === "url_credentials") {
      const shown = withoutCredentials(current as string);
      value = { value: shown, default_value: DEFAULT_SETTINGS[key], changed: current !== DEFAULT_SETTINGS[key], ...(shown !== current ? { redacted: true as const } : {}) };
    } else {
      value = { value: current, default_value: DEFAULT_SETTINGS[key], changed: !same(current, DEFAULT_SETTINGS[key]) };
    }
    return {
      name: key,
      type: rule.type,
      ...("value" in value ? { value: value.value } : {}),
      ...("default_value" in value ? { default_value: value.default_value } : {}),
      changed: value.changed,
      expected: rule.writeCheck?.expected ?? rule.expected,
      ...(rule.values ? { values: [...rule.values] } : {}),
      ...(rule.minimum !== undefined ? { minimum: rule.minimum } : {}),
      ...(rule.maximum !== undefined ? { maximum: rule.maximum } : {}),
      applies: rule.applies,
      editable: !rule.fileOnly,
      ...(rule.fileOnly ? { change_with: rule.fileOnly } : {}),
      restart_pending: rule.applies === "restart" && key in running && !same(current, running[key]),
      ...(overrides[key] ? { overridden_by: overrides[key] } : {}),
      ...(value.write_only ? { write_only: true as const } : {}),
      ...(value.redacted ? { redacted: true as const } : {}),
      ...(rule.sendsData ? { sends_data: true as const } : {}),
      ...(rule.warning ? { warning: rule.warning } : {}),
    };
  });
}

interface Refusal {
  setting: string;
  error: string;
  hint: string;
  docs: string;
  /** Sort key: the settings order, unknown names last in input order. */
  order: number;
}

function refusal(setting: string, error: string, g: Guidance, order: number): Refusal {
  return { setting, error, hint: g.hint, docs: g.docs, order };
}

function fail(status: number, error: string, g: Guidance): HandlerResponse {
  return { status, json: { error, hint: g.hint, docs: g.docs } };
}

const NOT_SAVED_HINT = "Nothing changed. Check that the engine can write its settings file and its store (disk space, permissions), then send the change again.";

/** The two settings routes over one engine's settings. */
export class SettingsRoutes {
  private readonly epoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  private revision = 1;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SettingsDeps) {}

  /** Opaque; changes with every applied change and every start. */
  get version(): string {
    return `${this.epoch}.${this.revision}`;
  }

  handlers(): Record<string, Handler> {
    return {
      "/settings/": async () => this.read(),
      "/settings/update/": async (body) => this.update(body),
    };
  }

  /** One change at a time; a failed one does not stop the queue. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private forbidden(route: string): HandlerResponse | null {
    const name = tokenNameOf(currentActor());
    return name ? { status: 403, json: { error: `token ${name} may not call ${route} (reserved to the owner)`, ...FORBIDDEN_HINT } } : null;
  }

  private view(s: DatanotesSettings): SettingView[] {
    return settingsView(s, this.deps.running(), this.deps.overrides());
  }

  private read(): HandlerResponse {
    const denied = this.forbidden("/settings/");
    if (denied) return denied;
    const settings = this.view(this.deps.getSettings());
    return {
      status: 200,
      json: {
        settings_file: this.deps.settingsFile(),
        settings_version: this.version,
        file_changed_on_disk: this.deps.fileChanged(),
        restart_pending: settings.filter((v) => v.restart_pending).map((v) => v.name),
        settings,
      },
    };
  }

  private async update(body: Body): Promise<HandlerResponse> {
    const denied = this.forbidden("/settings/update/");
    if (denied) return denied;
    const expectVersion = body.expect_version;
    if (typeof expectVersion !== "string" || expectVersion === "") {
      return fail(400, `"expect_version" is required: the settings_version that POST /datanotes/settings/ answers`, guide(`Read the settings first (POST /datanotes/settings/), then send your change with "expect_version" set to its settings_version.`, "changeSettings"));
    }
    const changes = body.changes;
    if (changes === null || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length === 0) {
      return fail(400, `"changes" must be an object of setting names and new values, such as {"logRetentionDays": 60}`, guide("Send each setting to change with its new value; null puts its default back. POST /datanotes/settings/ lists the settings.", "changeSettings"));
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return fail(400, `"dry_run" must be true or false`, guide("Pass dry_run: true to check a change without saving it.", "changeSettings"));
    }
    const dryRun = body.dry_run === true;
    const actor = currentActor();
    return this.serial(async () => this.apply(expectVersion, changes as Record<string, unknown>, dryRun, actor));
  }

  private async apply(expectVersion: string, changes: Record<string, unknown>, dryRun: boolean, actor: ReturnType<typeof currentActor>): Promise<HandlerResponse> {
    if (expectVersion !== this.version) {
      return fail(409, `the settings changed since you read them: settings_version is now "${this.version}"`, guide("Read them again (POST /datanotes/settings/), check your change against the new values, then send it with the new settings_version.", "changeSettings"));
    }
    if (this.deps.fileChanged()) {
      return fail(
        409,
        `the settings file changed on disk since the engine read it: ${this.deps.settingsFile()}`,
        guide("The engine reads the file's edits at its next start. Restart it (the Restart button of the engine settings page, POST /datanotes/restart/, or datanotes stop then start it again), then change the settings here; or undo the edits in the file.", "changeSettings"),
      );
    }
    const s = this.deps.getSettings();
    const { next, refused } = this.plan(s, changes);
    if (refused.length > 0) {
      refused.sort((a, b) => a.order - b.order);
      const first = refused[0]!;
      return {
        status: 400,
        json: { error: first.error, hint: first.hint, docs: first.docs, refused: refused.map((r) => ({ setting: r.setting, error: r.error, hint: r.hint })) },
      };
    }
    const changed = SETTING_KEYS.filter((k) => next.has(k));
    const after = { ...s, ...Object.fromEntries(next) } as DatanotesSettings;
    const settings = this.view(after);
    const followUps: { setting: string; description: string }[] = [];
    for (const k of changed) {
      const text = SETTING_RULES[k].followUp;
      if (text && !followUps.some((f) => f.description === text)) followUps.push({ setting: k, description: text });
    }
    const answer = (migrationId?: string): HandlerResponse => ({
      status: 200,
      json: {
        ok: true,
        dry_run: dryRun,
        settings_version: this.version,
        changed,
        applied_now: changed.filter((k) => SETTING_RULES[k].applies === "live"),
        after_restart: changed.filter((k) => SETTING_RULES[k].applies === "restart"),
        restart_pending: settings.filter((v) => v.restart_pending).map((v) => v.name),
        follow_ups: followUps,
        ...(migrationId !== undefined ? { migration_id: migrationId } : {}),
        settings,
      },
    });
    if (changed.length === 0 || dryRun) return answer();

    const prev = Object.fromEntries(changed.map((k) => [k, s[k]]));
    Object.assign(s, Object.fromEntries(next));
    try {
      await this.deps.saveSettings();
    } catch (e) {
      Object.assign(s, prev);
      return fail(503, `the settings could not be saved: ${messageOf(e)}`, guide(NOT_SAVED_HINT, "changeSettings"));
    }
    let id: string;
    try {
      id = await this.deps.journal(`set ${nameList(changed, 6)}`, changed.map((k) => record(k, prev[k], s[k])));
    } catch (e) {
      Object.assign(s, prev);
      await this.deps.saveSettings().catch(() => undefined);
      return fail(503, `the settings change could not be journaled: ${messageOf(e)}`, guide(NOT_SAVED_HINT, "changeSettings"));
    }
    this.revision++;
    const live = changed.filter((k) => SETTING_RULES[k].applies === "live");
    const restart = changed.filter((k) => SETTING_RULES[k].applies === "restart");
    this.deps.log(changed.some((k) => SETTING_RULES[k].warning) ? "WARN" : "INFO", "datanotes engine settings changed", {
      settings: changed.join(", "),
      applied_now: live.join(", "),
      after_restart: restart.join(", "),
      auth: actor?.auth ?? "owner",
      session: actor?.session ?? "",
      harness: actor?.harness ?? "",
      migration_id: id,
    });
    this.deps.afterChange(changed);
    return answer(id);
  }

  /** The new values of a change, or why each refused setting is refused. */
  private plan(s: DatanotesSettings, changes: Record<string, unknown>): { next: Map<EditableSettingKey, unknown>; refused: Refusal[] } {
    const next = new Map<EditableSettingKey, unknown>();
    const refused: Refusal[] = [];
    let unknown = 0;
    for (const [key, sent] of Object.entries(changes)) {
      const order = ORDER.get(key);
      if ((RUNTIME_KEYS as readonly string[]).includes(key)) {
        refused.push(refusal(key, `setting ${key} is set by the engine, not by the settings file`, guide("configure_database (root) moves the database folder; the database's id never changes.", "changeSettings"), order!));
        continue;
      }
      if (order === undefined) {
        refused.push(refusal(key, `no setting "${key}"`, unknownName(key, Object.keys(SETTING_RULES), "settings", "POST /datanotes/settings/ lists them with their values.", "changeSettings"), ORDER.size + unknown++));
        continue;
      }
      const k = key as EditableSettingKey;
      const rule = SETTING_RULES[k];
      if (rule.fileOnly) {
        refused.push(refusal(k, `setting ${k} cannot change over HTTP`, guide(rule.fileOnly, "changeSettings"), order));
        continue;
      }
      let raw = sent;
      if (raw === null) {
        if (rule.writeCheck) {
          refused.push(refusal(k, `setting ${k} cannot go back to a default: the engine always has an owner token`, guide(`Send a new token instead: ${rule.writeCheck.expected}.`, "changeSettings"), order));
          continue;
        }
        raw = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[k])) as unknown;
      } else if (rule.type === "string_map") {
        if (typeof raw !== "object" || Array.isArray(raw)) {
          refused.push(refusal(k, `setting ${k}: the value must be an object of header names and values`, guide(`${k} takes ${rule.expected}.`, "changeSettings"), order));
          continue;
        }
        const merged: Record<string, unknown> = { ...(s[k] as Record<string, string>) };
        const bad = Object.entries(raw as Record<string, unknown>).find(([, v]) => v !== null && typeof v !== "string");
        if (bad) {
          refused.push(refusal(k, `setting ${k}: the value of ${JSON.stringify(bad[0])} must be a string, or null to remove the header`, guide(`${k} takes ${rule.expected}.`, "changeSettings"), order));
          continue;
        }
        for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
          if (v === null) delete merged[name];
          else merged[name] = v;
        }
        raw = merged;
      } else if (rule.secret === "url_credentials" && typeof raw === "string") {
        // the address sent back as it was shown (credentials stripped): the stored credentials stay
        const cur = s[k] as string;
        if (withoutCredentials(cur) !== cur && raw.trim() === withoutCredentials(cur)) continue;
      }
      const c = checkSetting(k, raw);
      if (!c.ok) {
        refused.push(refusal(k, `setting ${k}: ${c.problem}`, guide(`${k} takes ${rule.writeCheck?.expected ?? rule.expected}.`, "changeSettings"), order));
        continue;
      }
      if (!same(c.value, s[k])) next.set(k, c.value);
    }
    return { next, refused };
  }
}

/** The journal's record of one setting changed: secrets left out, addresses without credentials. */
function record(name: EditableSettingKey, before: unknown, after: unknown): JournalSettingChange {
  const secret = SETTING_RULES[name].secret;
  if (secret === "value" || secret === "header_values") return { name, redacted: true };
  if (secret === "url_credentials") {
    const b = withoutCredentials(before as string);
    const a = withoutCredentials(after as string);
    return { name, before: b, after: a, ...(b !== before || a !== after ? { redacted: true as const } : {}) };
  }
  return { name, before, after };
}
