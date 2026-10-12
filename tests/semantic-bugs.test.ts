import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import type { HttpRequest, Transport } from "../src/core/embeddings";
import { SemanticIndex } from "../src/core/semantic";
import type { DatanotesSettings } from "../src/core/settings";
import { createDbVault, LOG_YAML, METASTORE } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

/** An OpenAI-compatible embedding service; `fail` answers 503 to the requests it matches. */
function service(fail: (req: HttpRequest) => boolean = () => false) {
  const calls: string[][] = [];
  const transport: Transport = async (req) => {
    const { input } = JSON.parse(req.body) as { input: string[] };
    calls.push(input);
    if (fail(req)) return { status: 503, text: JSON.stringify({ error: "warming up" }) };
    return { status: 200, text: JSON.stringify({ data: input.map((t, index) => ({ embedding: [t.length, 1, 0.5], index })) }) };
  };
  return { transport, calls };
}

function vault() {
  const v = createDbVault({
    [METASTORE]: LOG_YAML,
    "Books/Dune.md": "# Plot\nA desert planet, sand everywhere.\n# Food\nSpice in every dinner.\n",
    "Garden/Plan.md": "# Garden\nTomato and basil along the fence.\n",
  });
  Object.assign(v.settings, { semanticEnabled: true, semanticProvider: "custom", semanticBaseUrl: "http://emb.test/v1", semanticModel: "fake", semanticBatchSize: 1 } satisfies Partial<DatanotesSettings>);
  return v;
}

describe("a failed embedding batch", () => {
  it("fails only its note, even when the note has passages left in the queue, and the sync goes on", async () => {
    const v = vault();
    let down = true;
    const s = service((req) => down && req.body.includes("desert"));
    const idx = new SemanticIndex(v.app, () => v.settings, s.transport);
    const r = await idx.sync();
    expect(r.failed).toEqual([{ path: "Books/Dune.md", error: "embedding request failed (HTTP 503): warming up" }]);
    expect(r.embedded).toBe(1);
    // the note's other passage is not sent once the note failed
    expect(s.calls.some((input) => input.some((t) => t.includes("Spice")))).toBe(false);
    expect(idx.status()).toMatchObject({ files: 1, pending: 1 });
    // the failed note is tried again at the next sync of pending notes
    down = false;
    expect(await idx.sync({ onlyPending: true })).toMatchObject({ embedded: 1, failed: [] });
    expect(idx.status()).toMatchObject({ files: 2, pending: 0 });
  });
});
