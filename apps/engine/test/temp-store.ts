import { afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

/** Temp engine roots removed after each test, each seeded with a known Claude default so claims aren't withheld. */
export function useTempStores(): { root: () => string; readyStore: () => { store: EngineStore; root: string } } {
  const roots: string[] = [];
  afterEach(() => {
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  const root = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
    roots.push(directory);
    fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    return directory;
  };
  /** A store with `project_one` at /tmp and an empty `session_one`, on a clock stuck at 100. */
  const readyStore = () => {
    const stateRoot = root();
    const store = new EngineStore(stateRoot, () => 100);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    store.createSession({ id: "session_one", projectId: "project_one" });
    return { store, root: stateRoot };
  };
  return { root, readyStore };
}
