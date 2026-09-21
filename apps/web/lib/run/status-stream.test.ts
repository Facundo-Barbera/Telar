/**
 * The fold from a `run.status` frame onto a `/run/status` answer (#890).
 *
 * THE RULE UNDER TEST IS THAT A READER CANNOT TELL THE TWO APART. The masthead
 * reads status once and then never again, so an answer this function built has
 * to be shaped exactly like one the engine sent — same ordering, same `active`
 * — or the pill would drift from what a second window shows.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { applyRunStatusEvent } from "./status-stream";
import type { RunStatusAnswer, RunStatusEvent, RunView } from "./types";

const view = (overrides: Partial<RunView> = {}): RunView => ({
  runId: "run_a",
  projectId: "proj_1",
  configId: "cfg_1",
  configName: "dev",
  command: "bun run dev",
  worktreePath: "/tmp/tree",
  cwd: "/tmp/tree",
  status: "running",
  readiness: { kind: "none" },
  startedAt: 100,
  env: [],
  ...overrides,
});

const frame = (run: RunView, active: boolean): RunStatusEvent => ({ type: "run.status", projectId: "proj_1", run, active });

test("a frame about the holder becomes the active run, and history keeps newest first", () => {
  const older = view({ runId: "run_old", startedAt: 50, status: "exited" });
  const answer: RunStatusAnswer = { history: [older], sessionWorktreePath: "/tmp/tree" };

  const next = applyRunStatusEvent(answer, frame(view(), true));

  expect(next.active?.runId).toBe("run_a");
  expect(next.history.map((run) => run.runId)).toEqual(["run_a", "run_old"]);
  // The reader's own tree is not a property of any run, and must survive.
  expect(next.sessionWorktreePath).toBe("/tmp/tree");
});

test("the same run is replaced rather than duplicated", () => {
  const first = applyRunStatusEvent(undefined, frame(view({ status: "starting" }), true));
  const second = applyRunStatusEvent(first, frame(view({ status: "ready" }), true));

  expect(second.history).toHaveLength(1);
  expect(second.active?.status).toBe("ready");
});

test("a frame that says the run no longer holds the slot clears it, and a released run does not come back", () => {
  /**
   * THE CASE A CLIENT COULD NOT DERIVE. `release` frees the slot while the run
   * stays `unknown` for ever — that is what `unknown` means — so the status
   * alone says "still deployed". Only the frame's `active` gets this right.
   */
  const lost = view({ status: "unknown", error: "Telar lost contact" });
  const held = applyRunStatusEvent(undefined, frame(lost, true));
  expect(held.active?.runId).toBe("run_a");

  const released = applyRunStatusEvent(held, frame(lost, false));
  expect(released.active).toBeUndefined();
  // Still readable: history is what makes an exit legible.
  expect(released.history.map((run) => run.runId)).toEqual(["run_a"]);
});

test("an older run announcing its own exit does not clear the run that replaced it", () => {
  const live = applyRunStatusEvent(undefined, frame(view({ runId: "run_new", startedAt: 200 }), true));
  const next = applyRunStatusEvent(live, frame(view({ runId: "run_old", startedAt: 50, status: "exited" }), false));

  expect(next.active?.runId).toBe("run_new");
  expect(next.history.map((run) => run.runId)).toEqual(["run_new", "run_old"]);
});
