import { expect, test } from "bun:test";
import fs from "node:fs";
import { EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

test("a project whose git stalls or throws is still listed, without a branch, under a short bound", () => {
  // The registry is the source of truth for WHICH projects exist; git only
  // decorates them. Measured: one stalled `rev-parse` under ~/Documents made
  // the whole project list time out, and a thrown runner would have dropped
  // every project. Neither may cost the row.
  const projectRoot = fs.realpathSync.native(root());
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const git: import("../../platform/git/runner").GitRunner = (_cwd, args, options) => {
    calls.push({ args, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    if (args[0] === "rev-parse") return { status: 124, stdout: "", stderr: "git rev-parse ... did not finish within 5000ms and was killed", timedOut: true };
    throw new Error("runner exploded");
  };
  const store = new EngineStore(root(), () => 100, { git });
  store.projectRegistry.register({ id: "project_one", name: "One", root: projectRoot });
  const [listed] = store.projectRegistry.list();
  expect(listed).toMatchObject({ id: "project_one", name: "One", root: projectRoot });
  expect(listed?.branch).toBeUndefined();
  // The poll-path bound is tighter than the runner's general default.
  expect(calls.find((call) => call.args[0] === "rev-parse")?.timeoutMs).toBe(5_000);

  const exploding = new EngineStore(root(), () => 100, {
    git: () => {
      throw new Error("runner exploded");
    },
  });
  exploding.projectRegistry.register({ id: "project_two", name: "Two", root: projectRoot });
  expect(exploding.projectRegistry.list().map((project) => project.id)).toEqual(["project_two"]);
});
