/**
 * `npm run bench`: a move of the database folder on a vault of ~2000 rows whose generated link
 * column and plain notes name the folder by full path (`[[Datanotes/...]]`), while the engine runs.
 * The move is one operation: this measures how long a request made right after the rename waits
 * for it (links rewritten across the vault, generated columns recomputed in bulk, journal and
 * history), and checks that it left one journal entry and no broken link.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { movedVault, post } from "../tests/helpers/moved-vault";

const TASKS = Number(process.env.MOVE_BENCH_ROWS ?? 2000);
// the stores in a temporary data home, never the user's
process.env.DATANOTES_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "move-bench-home-"));

describe(`moving the database folder of ${TASKS} rows`, () => {
  it("by hand while the engine runs, then with configure_database root", async () => {
    const t = Date.now();
    const v = await movedVault(TASKS);
    console.log(`vault: ${TASKS} tasks, 30 days, ${v.notes.length} notes with full-path links (built in ${Date.now() - t} ms)`);
    const svc = await v.start({ watch: "events" });
    try {
      const since = new Date().toISOString();
      const t0 = Date.now();
      fs.renameSync(path.join(v.root, "Datanotes"), path.join(v.root, "datanotes"));
      const check = await post(v.port, "operations/check_table/", { table: "task" });
      const waited = Date.now() - t0;
      expect(JSON.stringify(check.json)).not.toContain("broken_link");
      const list = (await post(v.port, "operations/list_migrations/", { since })).json.migrations as { op: string; files: number }[];
      expect(list.map((m) => m.op)).toEqual(["move_database"]);
      console.log(`hand rename Datanotes -> datanotes: a request made at once answered after ${waited} ms (of which 1000 ms quiet time), one journal entry`);

      const t1 = Date.now();
      const r = await post(v.port, "operations/configure_database/", { root: "Areas/Db" });
      const took = Date.now() - t1;
      expect(r.json.root).toBe("Areas/Db");
      expect(JSON.stringify((await post(v.port, "operations/check_table/", { table: "task" })).json)).not.toContain("broken_link");
      console.log(`configure_database root datanotes -> Areas/Db: ${took} ms`);
    } finally {
      await svc.stop();
    }
  });
});
