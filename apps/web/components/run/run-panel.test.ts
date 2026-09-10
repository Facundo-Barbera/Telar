/**
 * The panel's polling cadence — the only decision in it that is not a fold over
 * something already tested next door.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { RunStatusAnswer, RunView } from "@/lib/run/types";
import { pollInterval, shouldPollOutput } from "./run-panel";

const view = (status: RunView["status"]): RunView => ({
  runId: "run_1",
  projectId: "proj_1",
  configId: "cfg_1",
  configName: "web dev",
  command: "bun run dev",
  worktreePath: "/trees/main",
  cwd: "/trees/main",
  startedAt: 1,
  status,
  readiness: { kind: "none" },
});

describe("pollInterval", () => {
  test("an idle project is not polled at a live cadence", () => {
    // Every open cockpit polls this. A project with nothing deployed asking
    // once a second, forever, is the cost that makes people close the panel.
    expect(pollInterval(undefined)).toBe(5000);
    expect(pollInterval({ history: [] })).toBe(5000);
  });

  test("a starting run is watched closely, a settled one is not", () => {
    expect(pollInterval({ history: [], active: view("starting") })).toBe(1000);
    expect(pollInterval({ history: [], active: view("running") })).toBe(1000);
    expect(pollInterval({ history: [], active: view("ready") })).toBe(3000);
    expect(pollInterval({ history: [], active: view("exited") })).toBe(5000);
  });

  test("a run Telar lost is not polled hard either — nothing about it will change", () => {
    expect(pollInterval({ history: [], active: view("unknown") })).toBe(5000);
  });
});

describe("shouldPollOutput", () => {
  test("output is still fetched for a run that has ended, because it is retained", () => {
    const answer: RunStatusAnswer = { history: [], active: view("exited") };
    expect(shouldPollOutput(answer)).toBe(true);
    expect(shouldPollOutput({ history: [] })).toBe(false);
  });
});
