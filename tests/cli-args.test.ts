import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/api/index";
import { help } from "../src/node/help";
import { CliOptionError, folderArg, readOptions } from "../src/api/cli-options";
import { parseArgs } from "../src/node/service";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("datanotes serve: options and their environment variables", () => {
  it("every option from the environment when the command line does not give it", () => {
    const env = {
      DATANOTES_VAULT: "/srv/vault",
      DATANOTES_WATCH: "poll",
      DATANOTES_POLL_MS: "1500",
      DATANOTES_SETTINGS: "/etc/datanotes/settings.json",
      DATANOTES_EMBEDDING_KEY_FILE: "/run/secrets/embedding",
      DATANOTES_HOST: "0.0.0.0",
      DATANOTES_GIT_SYNC: "1",
      DATANOTES_GIT_INTERVAL_MIN: "30",
      DATANOTES_GIT_QUIET_S: "120",
    };
    expect(parseArgs([], env)).toEqual({
      vault: path.resolve("/srv/vault"),
      watch: "poll",
      pollMs: 1500,
      settingsFile: "/etc/datanotes/settings.json",
      embeddingKeyFile: "/run/secrets/embedding",
      host: "0.0.0.0",
      gitSync: { intervalMs: 30 * 60_000, quietMs: 120_000, push: true },
    });
  });

  it("the command line wins over the environment", () => {
    const o = parseArgs(["--vault", "/v", "--host", "127.0.0.2", "--settings", "s.json", "--embedding-key-file", "k.txt"], { DATANOTES_VAULT: "/env", DATANOTES_HOST: "0.0.0.0" });
    expect(o).toEqual({ vault: path.resolve("/v"), watch: "events", pollMs: 3000, host: "127.0.0.2", settingsFile: "s.json", embeddingKeyFile: "k.txt" });
    expect(parseArgs(["--vault", "/v", "--log", "logs/dn.log"], {}).logFile).toBe(path.resolve("logs/dn.log"));
  });

  it("values out of range fall back to the defaults: poll at least 200 ms, git every minute at least, quiet 5 s at least", () => {
    expect(parseArgs(["--vault", "/v", "--poll-ms", "50"], {}).pollMs).toBe(3000);
    expect(parseArgs(["--vault", "/v", "--poll-ms", "often"], {}).pollMs).toBe(3000);
    expect(parseArgs(["--vault", "/v", "--git-sync", "--git-interval-min", "0", "--git-quiet-s", "1"], {}).gitSync).toEqual({ intervalMs: 10 * 60_000, quietMs: 60_000, push: true });
    expect(parseArgs(["--vault", "/v", "--git-sync", "--git-interval-min", "x", "--git-quiet-s", "y"], {}).gitSync).toEqual({ intervalMs: 10 * 60_000, quietMs: 60_000, push: true });
  });

  it("the store backup: on, off, a remote that turns it on, the cadence, from flags or the environment", () => {
    expect(parseArgs(["--vault", "/v", "--store-backup"], {}).storeBackup).toEqual({ enabled: true });
    expect(parseArgs(["--vault", "/v"], { DATANOTES_STORE_BACKUP: "1" }).storeBackup).toEqual({ enabled: true });
    expect(parseArgs(["--vault", "/v", "--no-store-backup"], { DATANOTES_STORE_BACKUP: "1" }).storeBackup).toEqual({ enabled: false });
    expect(parseArgs(["--vault", "/v"], { DATANOTES_STORE_BACKUP: "0", DATANOTES_STORE_BACKUP_REMOTE: "git@h:me/s.git" }).storeBackup).toEqual({ enabled: false, remote: "git@h:me/s.git" });
    expect(parseArgs(["--vault", "/v", "--store-backup-remote", "https://h/s.git", "--store-backup-interval-s", "30"], {}).storeBackup).toEqual({ enabled: true, remote: "https://h/s.git", every: 30_000 });
    expect(parseArgs(["--vault", "/v"], { DATANOTES_STORE_BACKUP_INTERVAL_S: "90" }).storeBackup).toEqual({ every: 90_000 });
    expect(parseArgs(["--vault", "/v"], {}).storeBackup).toBeUndefined();
    expect(() => parseArgs(["--vault", "/v", "--store-backup-interval-s", "9"], {})).toThrow('--store-backup-interval-s must be a whole number of seconds, at least 10: "9"');
    expect(() => parseArgs(["--vault", "/v"], { DATANOTES_STORE_BACKUP_INTERVAL_S: "operation" })).toThrow('--store-backup-interval-s must be a whole number of seconds, at least 10: "operation"');
    // the error says how to fix it, and where to read more
    let err: unknown;
    try {
      parseArgs(["--vault", "/v", "--store-backup-interval-s", "5"], {});
    } catch (e) {
      err = e;
    }
    expect((err as { hint: string }).hint).toContain("--store-backup-interval-s 60");
    expect((err as { docs: string }).docs).toBe("https://datanotes.dev/guides/history/back-up.md#choose-how-often-the-backup-commits");
    expect(() => parseArgs(["--vault", "/v", "--store-backup-interval-s", "often"], {})).toThrow(/--store-backup-interval-s must be/);
  });

  it("reads --name=value; refuses an option it does not know, a value missing, a value given to a flag", () => {
    expect(parseArgs(["--vault=/v", "--port=0", "--watch=poll"], {})).toMatchObject({ vault: path.resolve("/v"), port: 0, watch: "poll" });
    const refusal = (argv: string[]) => {
      try {
        parseArgs(argv, {});
      } catch (e) {
        return e as CliOptionError;
      }
      throw new Error("not refused");
    };
    const typo = refusal(["--vault", "/v", "--prot", "0"]);
    expect(typo).toBeInstanceOf(CliOptionError);
    expect(typo.message).toBe("unknown option --prot");
    expect(typo.hint).toMatch(/^Did you mean "--port"\? datanotes serve takes: --vault, /);
    expect(typo.docs).toBe("https://datanotes.dev/reference/cli.md");
    expect(refusal(["--vault"]).message).toBe("--vault needs a value");
    expect(refusal(["--vault", "/v", "--port", "--watch", "poll"]).message).toBe("--port needs a value");
    expect(refusal(["--vault", "/v", "--git-sync=yes"]).message).toBe("--git-sync takes no value");
    expect(refusal(["serve", "--vault", "/v"]).message).toBe('unexpected argument "serve"');
    // the options engines before 3.0 took are gone, not ignored
    expect(refusal(["--vault", "/v", "--extension", "x.js"]).message).toBe("unknown option --extension");
  });
});

describe("the options of a command: readOptions and folderArg", () => {
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e as CliOptionError;
    }
    throw new Error("not refused");
  };

  it("a command that takes flags only, or nothing at all", () => {
    const flagsOnly = readOptions(["--quiet"], { flags: ["quiet"] }, "datanotes tidy");
    expect([flagsOnly.has("quiet"), flagsOnly.get("quiet")]).toEqual([true, undefined]);
    expect(refusal(() => readOptions(["--quiet=yes"], { flags: ["quiet"] }, "datanotes tidy")).hint).toBe("Write --quiet alone. datanotes tidy takes: --quiet (datanotes tidy --help).");
    const none = refusal(() => readOptions(["--verbose"], {}, "datanotes ping"));
    expect([none.message, none.hint]).toEqual(["unknown option --verbose", "datanotes ping takes: no options (datanotes ping --help)."]);
  });

  it("the folder from the environment: DATANOTES_DATABASE or DATANOTES_VAULT, never both", () => {
    const o = readOptions([], { values: ["database", "vault"] }, "datanotes check");
    expect(folderArg(o, { DATANOTES_DATABASE: "/db" }, "datanotes check")).toEqual({ folder: "/db", atRoot: true });
    expect(folderArg(o, { DATANOTES_VAULT: "/vault" }, "datanotes check")).toEqual({ folder: "/vault", atRoot: false });
    expect(folderArg(o, {}, "datanotes check", false)).toBeNull();
    const both = refusal(() => folderArg(o, { DATANOTES_DATABASE: "/db", DATANOTES_VAULT: "/vault" }, "datanotes check"));
    expect(both.message).toBe("datanotes check: DATANOTES_DATABASE and DATANOTES_VAULT name the folder twice");
    expect(both.hint).toMatch(/^Pass --database <folder> when the folder is the database/);
  });
});

describe("datanotes --help", () => {
  it("names the version and every option `serve` reads", () => {
    const text = help("3.0.0");
    expect(text.startsWith("datanotes 3.0.0: ")).toBe(true);
    for (const option of ["--vault", "--settings", "--host", "--port", "DATANOTES_PORT", "--watch", "--poll-ms", "--embedding-key-file", "--git-sync", "--git-interval-min", "--git-quiet-s", "--git-no-push", "--log", "--store-backup", "--store-backup-remote", "--store-backup-interval-s", "--interval-s", "--no-store-backup", "store backup", "store restore", "--from", "--no-backup", "datanotes stop --database", "--database", "DATANOTES_DATABASE", "--timeout"]) {
      expect(text).toContain(option);
    }
  });
});

describe("datanotes/client: the published entry point", () => {
  it("exports the catalogue, the request builder, the result helpers, the client and the OTLP exporter", () => {
    expect(Object.keys(client).sort()).toEqual(
      [
        "ACTOR_HEADER",
        "CALLABLE_OPERATIONS",
        "DOCS_BASE",
        "DatanotesClient",
        "DatanotesError",
        "OPERATIONS",
        "OperationInputError",
        "OtlpLogExporter",
        "ROUTE_PREFIX",
        "argumentsOf",
        "checkArguments",
        "describeBatch",
        "describeRefusal",
        "estimateTokens",
        "fetchTransport",
        "guidanceIn",
        "guidedText",
        "operationRequest",
        "operationRoute",
        "otlpFromEnv",
        "parseOtlpHeaders",
        "resultOf",
        "toolDocs",
      ].sort(),
    );
    expect(client.OPERATIONS.length).toBeGreaterThan(50);
  });
});
