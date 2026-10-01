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

test("the dirty count is one git status, not a diff", async () => {
  const ran: string[] = [];
  const store = new EngineStore(root(), () => 100, {
    git: (_cwd, args) => {
      ran.push(args.filter((arg) => !arg.includes("=")).filter((arg) => arg !== "-c").join(" "));
      return { status: 0, stdout: " M a.ts\n?? b.ts\n", stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  ran.length = 0;
  expect(await store.workspaceReads.sessionDirty("session_one")).toEqual({ dirtyFiles: 2 });
  expect(ran).toEqual(["status --porcelain"]);
});

test("an unreadable checkout gives no dirty count", async () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 128, stdout: "", stderr: "fatal" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  expect(await store.workspaceReads.sessionDirty("session_one")).toEqual({});
});
