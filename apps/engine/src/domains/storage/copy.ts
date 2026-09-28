import fs from "node:fs";
import path from "node:path";
import { EngineStateError } from "../../platform/kernel";
import type { ExecutionStore } from "../../platform/db/execution-store";

// Reproducible from a sha or a re-install, the live daemon's lock, and the database's own files.
const SKIPPED = new Set(["worktrees", "python", "tools", "engine.lock", "execution.sqlite", "execution.sqlite-wal", "execution.sqlite-shm"]);

// Iterative: a store can hold node_modules trees deeper than the call stack.
function* walkFiles(root: string): Generator<number> {
  const frontier = [root];
  while (frontier.length > 0) {
    const at = frontier.pop()!;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(at); } catch { continue; }
    if (stat.isDirectory()) {
      try { for (const name of fs.readdirSync(at)) frontier.push(path.join(at, name)); } catch { /* unreadable: counted as nothing */ }
      continue;
    }
    yield stat.size;
  }
}

/**
 * A copy of the store someone can open and throw away instead of the live one.
 * The database goes through `VACUUM INTO` so it is consistent; everything else
 * at the root is copied except the reproducible tier. The destination must not exist.
 */
export function copyStore(root: string, executionStore: ExecutionStore, destination: string): { root: string; files: number; bytes: number } {
  if (!path.isAbsolute(destination)) throw new EngineStateError("invalid_request", "a copy destination must be an absolute path");
  if (fs.existsSync(destination)) throw new EngineStateError("invalid_request", "that folder already exists — choose one Telar can create");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  executionStore.vacuumInto(path.join(destination, "execution.sqlite"));
  let files = 1;
  let bytes = fs.statSync(path.join(destination, "execution.sqlite")).size;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const to = path.join(destination, entry.name);
    try {
      fs.cpSync(path.join(root, entry.name), to, { recursive: true, errorOnExist: true, force: false, dereference: false });
    } catch {
      // One unreadable subtree is not a failed copy; refusing would send someone back to the live store.
      continue;
    }
    for (const measured of walkFiles(to)) { files += 1; bytes += measured; }
  }
  return { root: destination, files, bytes };
}
