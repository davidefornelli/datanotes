/**
 * Node versions with a known crash on Windows: libuv 1.51.0 (Node 24.0-24.15 and 26.0) aborts the
 * process at random (exit 0xC0000409) on TCP connects to 127.0.0.1, which the engine, its clients
 * and the MCP server all make. Fixed in Node 24.16.0 and 26.1.0. `datanotes serve` and
 * `datanotes mcp` warn at start; `scripts/verify.mjs` warns for the tests.
 */

/** The warning for this platform and Node version, or null when the version is safe. */
export function nodeVersionWarning(platform: string = process.platform, version: string = process.versions.node): string | null {
  if (platform !== "win32") return null;
  const [major, minor] = version.split(".").map(Number);
  const affected = (major === 24 && minor! <= 15) || (major === 26 && minor === 0);
  if (!affected) return null;
  return `datanotes: WARNING Node ${version} on Windows can crash at random on local connections (exit 0xC0000409, a libuv bug); use Node 24.16 or later, or 26.1 or later. See https://datanotes.dev/start/quick-start.md`;
}
