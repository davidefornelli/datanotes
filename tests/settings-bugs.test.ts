import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeWithDefaults } from "../src/core/settings";

describe("httpServerPort", () => {
  it("keeps a valid port, and 0 (any free port)", () => {
    expect(mergeWithDefaults({ httpServerPort: 27151 }).httpServerPort).toBe(27151);
    expect(mergeWithDefaults({ httpServerPort: 1024 }).httpServerPort).toBe(1024);
    expect(mergeWithDefaults({ httpServerPort: 65535 }).httpServerPort).toBe(65535);
    expect(mergeWithDefaults({ httpServerPort: 0 }).httpServerPort).toBe(0);
    expect(mergeWithDefaults({}).httpServerPort).toBe(DEFAULT_SETTINGS.httpServerPort);
  });

  it.each([-1, 80, 1023, 65536, 2.5, Number.NaN, "27151", null])("refuses %s instead of taking the default port (another engine's)", (port) => {
    expect(() => mergeWithDefaults({ httpServerPort: port as never })).toThrow(/^invalid setting httpServerPort: .* \(an integer from 1024 to 65535, or 0 for any free port\)$/);
  });
});
