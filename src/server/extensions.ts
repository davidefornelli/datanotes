/**
 * The extension registry: which extensions are installed in the database (docs:
 * administration/extensions). The records live in the engine's store (`store:extensions.json`,
 * next to `tokens.json`). The engine only keeps them: MCP servers read them over HTTP and run the
 * extensions' code (the engine never runs it).
 */

import { currentActor } from "../core/actor";
import type { App } from "../core/host";
import { messageOf } from "../core/message";
import type { DatanotesSettings } from "../core/settings";
import { storePath, storeRead, storeWrite } from "../core/store";
import { telemetry } from "../core/telemetry";
import { DOCS_BASE } from "../api/guidance";
import { MAX_RECORD_CHARS, recordProblems, type InstalledExtension } from "../api/extension-record";
import { BadRequest, Forbidden, type Handler } from "./rest";
import { tokenNameOf } from "./tokens";

const FILE = "extensions.json";
/** Where the registry is explained (the same address as EXT_DOCS.where of src/api/extension-manifest.ts). */
const WHERE_DOCS = `${DOCS_BASE}/administration/extensions.md#where-extensions-live`;
const HINT = "datanotes extension install writes this record; to change an extension, run datanotes extension update or remove.";
const GUIDE = { hint: HINT, docs: WHERE_DOCS };

interface Deps {
  app: App;
  getSettings(): DatanotesSettings;
}

export class ExtensionRegistry {
  private records: InstalledExtension[] = [];
  private loaded: Promise<void> | null = null;
  private saving: Promise<boolean> = Promise.resolve(true);

  constructor(private readonly deps: Deps) {}

  /** Read the registry (once): a missing or unreadable file counts as empty. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const text = await storeRead(this.deps.app, storePath(FILE));
        if (text !== null) {
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error("the file does not hold a list");
          this.records = parsed as InstalledExtension[];
        }
      } catch (e) {
        telemetry().log("WARN", "datanotes could not read the extension registry", { error: messageOf(e) });
        this.records = [];
      }
    })();
    return this.loaded;
  }

  /** The records, sorted by name. */
  list(): InstalledExtension[] {
    return [...this.records].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(name: string): InstalledExtension | undefined {
    return this.records.find((r) => r.name === name);
  }

  /** Write the registry; the records stay in memory when it cannot be written. */
  private save(): Promise<boolean> {
    this.saving = this.saving
      .then(() => storeWrite(this.deps.app, storePath(FILE), `${JSON.stringify(this.list(), null, 2)}\n`))
      .then(
        () => true,
        (e: unknown) => {
          telemetry().log("WARN", "datanotes could not save extensions.json", { error: messageOf(e) });
          return false;
        },
      );
    return this.saving;
  }

  /** Add a record, or replace the one of the same name. */
  async put(record: InstalledExtension): Promise<InstalledExtension> {
    await this.load();
    this.records = [...this.records.filter((r) => r.name !== record.name), record];
    await this.save();
    telemetry().log("INFO", "datanotes extension recorded", { extension_name: record.name, extension_version: record.version });
    return record;
  }

  /** Forget a record; false when there was none. */
  async remove(name: string): Promise<boolean> {
    await this.load();
    if (!this.get(name)) return false;
    this.records = this.records.filter((r) => r.name !== name);
    await this.save();
    telemetry().log("INFO", "datanotes extension removed", { extension_name: name });
    return true;
  }

  /** Wait for the last save. */
  async stop(): Promise<void> {
    await this.saving;
  }

  /** `/datanotes/extensions/*`: the list for any token, the changes for the owner. */
  handlers(): Record<string, Handler> {
    const ownerOnly = () => {
      if (tokenNameOf(currentActor())) throw new Forbidden("reserved to the owner");
    };
    return {
      "/extensions/": async () => {
        await this.load();
        return { status: 200, json: { database_id: this.deps.getSettings().databaseId || null, extensions: this.list() } };
      },
      "/extensions/record/": async (b) => {
        ownerOnly();
        if (JSON.stringify(b).length > MAX_RECORD_CHARS) throw new BadRequest(`the record is larger than ${MAX_RECORD_CHARS} characters`, GUIDE);
        const problems = recordProblems(b);
        if (problems.length > 0) throw new BadRequest(`invalid extension record: ${problems.join("; ")}`, GUIDE);
        return { status: 200, json: { extension: await this.put(b as unknown as InstalledExtension) } };
      },
      "/extensions/delete/": async (b) => {
        ownerOnly();
        if (typeof b.name !== "string" || b.name === "") throw new BadRequest(`"name" is required`, GUIDE);
        return { status: 200, json: { deleted: await this.remove(b.name) } };
      },
    };
  }
}
