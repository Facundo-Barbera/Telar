import { expect, test } from "bun:test";
import path from "node:path";
import type { ExecutionStore } from "../db/execution-store";
import type { EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
}

test("a v1 document names the version break instead of reading as corruption", () => {
  const { store, root: stateRoot } = readyStore();
  editDocument(store, stateRoot, "queue.json", (queue) => { queue.version = 1; });
  // A bare schema failure here would read as disk corruption and send an
  // operator looking in the wrong place.
  expect(() => store.turns("session_one")).toThrow(/protocol v1/);
});
