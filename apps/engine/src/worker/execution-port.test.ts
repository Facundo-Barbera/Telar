import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../state";
import { createExecutionPort } from "./execution-port";

const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("a completed turn is announced once, and a failed one is not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-port-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(root, () => 100);
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  const completed: string[] = [];
  const port = createExecutionPort(store, {} as never, () => undefined, (id) => completed.push(id));

  const runTurn = (runId: string) => {
    store.intake.submitTurn("session_one", { runId, input: "Hello" });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", runId, token);
    return token;
  };
  await port.failTurn("session_one", "run_one", runTurn("run_one"), { code: "driver_failed", message: "boom" });
  await port.completeTurn("session_one", "run_two", runTurn("run_two"), { text: "done" });
  expect(completed).toEqual(["session_one"]);
});
