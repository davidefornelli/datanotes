import { describe, expect, it } from "vitest";
import { FileLogger, TeeTelemetry, type Severity, type Telemetry } from "../src/core/telemetry";

/** Local date `YYYY-MM-DD` of an instant: the log file a record goes to. */
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A log folder in memory: file name → appended text. */
function logFolder(fail: (day: string) => Error | undefined = () => undefined) {
  const files = new Map<string, string>();
  const write = async (day: string, lines: string) => {
    const e = fail(day);
    if (e) throw e;
    files.set(day, (files.get(day) ?? "") + lines);
  };
  return { files, write };
}

describe("FileLogger", () => {
  it("stamps records with the system clock when no clock is given", async () => {
    const folder = logFolder();
    const logger = new FileLogger({ enabled: () => true, write: folder.write });
    const before = Date.now();
    logger.log("INFO", "datanotes http", { "http.route": "/datanotes/operations/select_rows/", "http.response.status_code": 200 });
    const after = Date.now();
    await logger.flush();
    const [day, text] = [...folder.files][0]!;
    const record = JSON.parse(text) as Record<string, unknown>;
    const at = Date.parse(record.time as string);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(day).toBe(localDay(at));
    expect(record).toEqual({ time: record.time, level: "INFO", msg: "datanotes http", "http.route": "/datanotes/operations/select_rows/", "http.response.status_code": 200 });
  });

  it("drops undefined attributes and keeps null ones", async () => {
    const folder = logFolder();
    const at = new Date(2026, 9, 8, 9, 15, 0).getTime();
    const logger = new FileLogger({ enabled: () => true, write: folder.write, now: () => at });
    logger.log("WARN", "datanotes undo_migration", { table: "log", migration: undefined, actor: null, ok: false });
    await logger.flush();
    expect(folder.files.get("2026-10-08")).toBe(`{"time":"${new Date(at).toISOString()}","level":"WARN","msg":"datanotes undo_migration","table":"log","actor":null,"ok":false}\n`);
  });

  it("writes nothing while disabled", async () => {
    const folder = logFolder();
    const logger = new FileLogger({ enabled: () => false, write: folder.write, now: () => 0 });
    logger.log("ERROR", "datanotes rename_column");
    await logger.flush();
    expect(folder.files.size).toBe(0);
  });

  it("counts the records of a day it could not write, writes the other days, and keeps working", async () => {
    let full = true;
    const folder = logFolder((day) => (day === "2026-10-08" && full ? new Error("ENOSPC: no space left on device") : undefined));
    let t = new Date(2026, 9, 8, 23, 59, 58).getTime();
    const logger = new FileLogger({ enabled: () => true, write: folder.write, now: () => t });
    const log = (sev: Severity, msg: string) => logger.log(sev, msg);
    log("INFO", "a");
    log("INFO", "b");
    t = new Date(2026, 9, 9, 0, 0, 1).getTime();
    log("INFO", "c");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.dropped).toBe(2);
    expect([...folder.files.keys()]).toEqual(["2026-10-09"]);
    expect(folder.files.get("2026-10-09")!.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["c"]);
    // the disk has room again: later records are written
    full = false;
    t = new Date(2026, 9, 8, 12, 0, 0).getTime();
    log("INFO", "d");
    await logger.flush();
    expect(logger.dropped).toBe(2);
    expect((JSON.parse(folder.files.get("2026-10-08")!) as { msg: string }).msg).toBe("d");
  });

  it("a flush with nothing new waits for the writes still running", async () => {
    let release!: () => void;
    const written: string[] = [];
    const logger = new FileLogger({
      enabled: () => true,
      now: () => new Date(2026, 9, 8, 9, 0, 0).getTime(),
      write: async (_day, lines) => {
        await new Promise<void>((r) => (release = r));
        written.push(lines);
      },
    });
    logger.log("INFO", "slow");
    const first = logger.flush();
    const second = logger.flush();
    let done = false;
    void second.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(done).toBe(true);
    expect(written).toHaveLength(1);
  });
});

describe("TeeTelemetry", () => {
  it("sends every record to every sink and flushes them all", async () => {
    const seen: string[] = [];
    const flushed: string[] = [];
    const sink = (name: string): Telemetry => ({
      log: (sev, body, attrs) => void seen.push(`${name} ${sev} ${body} ${JSON.stringify(attrs ?? null)}`),
      flush: async () => void flushed.push(name),
    });
    const tee = new TeeTelemetry([sink("otlp"), sink("file")]);
    tee.log("ERROR", "datanotes batch rolled back", { failed_at: 1 });
    tee.log("DEBUG", "tick");
    await tee.flush();
    expect(seen).toEqual([
      'otlp ERROR datanotes batch rolled back {"failed_at":1}',
      'file ERROR datanotes batch rolled back {"failed_at":1}',
      "otlp DEBUG tick null",
      "file DEBUG tick null",
    ]);
    expect(flushed).toEqual(["otlp", "file"]);
  });
});
