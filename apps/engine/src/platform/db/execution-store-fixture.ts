import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";

export const homes: string[] = [];
export const stores: EngineStore[] = [];

/** Closes the tracked stores and removes the tracked homes; pass to `afterEach`. */
export function cleanup(): void {
  for (const store of stores.splice(0)) store.kernel.executionStore.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
}

export function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sqlite-")); homes.push(home);
  const store = new EngineStore(home, Date.now); stores.push(store);
  store.projectRegistry.register({ id: "project_one", name: "one", root: "/tmp" });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  return { home, store };
}
