/**
 * Every test file: the engine's data home (where it keeps the stores of its databases) is a
 * temporary folder, never the user's own (%LOCALAPPDATA%\Datanotes, ~/.local/share/datanotes...).
 * Engines started by the tests, in process or as child processes, inherit it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATANOTES_DATA_HOME) process.env.DATANOTES_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-data-home-"));
