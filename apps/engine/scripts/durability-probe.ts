/**
 * OPEN A SCRATCH EXECUTION STORE AND PRINT THE PRAGMAS IT ENDED UP WITH.
 *
 * Not a test and not run by the suite. It is the entry `durability-pragmas.mjs`
 * bundles and hands to plain `node`, which is the only runtime in which the
 * answer means anything for the packaged app — see that script's header.
 *
 * It prints JSON on one line and nothing else, so the caller parses rather than
 * greps. Nothing here touches a real store: the database is made in a temp
 * directory and removed before this returns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution-store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-probe-"));
try {
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  const pragmas = store.durabilityPragmas();
  store.close();
  console.log(JSON.stringify({ runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, ...pragmas }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
