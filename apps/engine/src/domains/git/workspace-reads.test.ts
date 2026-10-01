import { expect, test } from "bun:test";
import fs from "node:fs";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

test("a file patch cannot be asked for outside the session's own workspace", () => {
  // `git diff -- <path>` takes a pathspec, and `../../` in one is how a client
  // asks to read a file it was never offered. Fenced in the store rather than at
  // the route, so an in-process caller cannot walk past it either.
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.workspaceReads.sessionFilePatch("session_one", "../../etc/passwd")).toThrow(EngineStateError);
  expect(() => store.workspaceReads.sessionFilePatch("session_one", "  ")).toThrow(EngineStateError);
});

let clock = 100;

function storeWithGit(stdout: string) {
  const ran: string[] = [];
  const store = new EngineStore(root(), () => clock, {
    git: (cwd, args) => {
      if (args.includes("status")) ran.push(cwd);
      return { status: 0, stdout, stderr: "" };
    },
  });
  const checkout = fs.realpathSync.native(root());
  store.projectRegistry.register({ id: "project_one", name: "One", root: checkout });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  store.lifecycle.createSession({ id: "session_two", projectId: "project_one" });
  ran.length = 0;
  return { store, ran };
}

test("sessions on one checkout share one git status", async () => {
  const { store, ran } = storeWithGit("# branch.oid abc\0" + "1 .M N... 100644 100644 100644 a b a.ts\0? b.ts\0");
  const one = await store.workspaceReads.sessionStatus("session_one");
  expect(one.dirtyFiles).toBe(2);
  expect(await store.workspaceReads.sessionStatus("session_two")).toEqual(one);
  expect(ran).toHaveLength(1);
});

test("a file change landing in a turn makes the next status read run again", async () => {
  const { store, ran } = storeWithGit("# branch.oid abc\0");
  await store.workspaceReads.sessionStatus("session_one");
  store.intake.submitTurn("session_one", { runId: "run_one", input: "edit" });
  const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i_1", detail: { type: "file_change", change: { path: "a.ts", kind: "edit" } } } },
  ]);
  const before = ran.length;
  await store.workspaceReads.sessionStatus("session_two");
  expect(ran).toHaveLength(before);
  store.ingest.ingestObservations("session_one", "run_one", token, [{ kind: "item.completed", itemId: "i_1", status: "completed" }]);
  clock += 3_000;
  await store.workspaceReads.sessionStatus("session_two");
  expect(ran).toHaveLength(before + 1);
});

test("an unreadable checkout gives no dirty count", async () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 128, stdout: "", stderr: "fatal" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  expect((await store.workspaceReads.sessionStatus("session_one")).dirtyFiles).toBeUndefined();
});
