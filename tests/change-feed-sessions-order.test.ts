/**
 * ChangeFeed.sessions orders two sessions whose last events share a time by their sequence number:
 * the later event comes first (R1w2-6). The ordering failures of tests/sessions-route.test.ts on CI
 * had another cause: sessions() read the day files before the feed had recorded the events of a
 * write already answered (fixed by waiting for the feed's queue; tested there).
 */

import { describe, expect, it } from "vitest";
import { ChangeFeed } from "../src/core/change-feed";
import { storePath, storeWrite } from "../src/core/store";
import { createDbVault, LOG_YAML, METASTORE } from "./helpers/db-vault";

const AT = "2026-11-02T10:00:00.000Z";

function line(seq: number, auth: string): string {
  return JSON.stringify({ seq, at: AT, table: null, op: "tool_call", path: "", source: "engine", actor: { auth } });
}

async function order(cookSeq: number, ownerSeq: number): Promise<string[]> {
  const v = createDbVault({ [METASTORE]: LOG_YAML });
  await storeWrite(v.app, storePath("changes", "2026-11-02.jsonl"), `${line(cookSeq, "cook")}\n${line(ownerSeq, "owner")}\n`);
  const sessions = await new ChangeFeed(v.app, () => v.settings).sessions(Date.parse("2026-11-02T00:00:00Z"), { limit: 10 });
  return sessions.map((s) => s.token);
}

describe("ChangeFeed.sessions, two last events at the same time", () => {
  it("puts the later event first", async () => {
    expect(await order(1, 2)).toEqual(["owner", "cook"]);
    expect(await order(2, 1)).toEqual(["cook", "owner"]);
  });
});
