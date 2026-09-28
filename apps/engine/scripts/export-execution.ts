import fs from "node:fs";
import path from "node:path";
import { ExecutionStore } from "../src/platform/db/execution-store";
import { acquireDaemonLock } from "../src/state";
import { statePaths } from "../src/platform/fs/state-paths";

const [home, destination] = process.argv.slice(2);
if (!home || !destination) throw new Error("Usage: bun apps/engine/scripts/export-execution.ts ENGINE_HOME NEW_EXPORT_DIRECTORY");
if (!fs.existsSync(path.join(home, "execution.sqlite"))) throw new Error("No SQLite execution store in this home");
const lock = acquireDaemonLock(statePaths(path.resolve(home)));
try {
  const store = new ExecutionStore(path.resolve(home));
  try { store.exportLegacy(path.resolve(destination)); }
  finally { store.close(); }
  console.log(`Execution history exported to ${path.resolve(destination)}. Attachments and other application data remain in the source home.`);
} finally { lock.release(); }
