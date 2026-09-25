/**
 * The fold from a `run.status` frame onto a `/run/status` answer (#890).
 *
 * THE RULE UNDER TEST IS THAT A READER CANNOT TELL THE TWO APART. The masthead
 * reads status once and then never again, so an answer this function built has
 * to be shaped exactly like one the engine sent — the same list, the same
 * ordering — or the pill would drift from what a second window shows.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { applyRunStatusEvent } from "./status-stream";
import type { RunStatusAnswer, RunStatusEvent, RunView } from "./types";

const view = (overrides: Partial<RunView> = {}): RunView => ({
  terminalId: "term_a",
  runId: "term_a",
  projectId: "proj_1",
  sessionId: "sess_1",
  origin: "run",
  title: "dev",
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

const frame = (run: RunView): RunStatusEvent => ({ type: "run.status", projectId: "proj_1", sessionId: "sess_1", run });

test("a frame about a new terminal joins the list, newest first", () => {
  const older = view({ terminalId: "term_old", runId: "term_old", startedAt: 50, status: "exited" });
  const answer: RunStatusAnswer = { terminals: [older], sessionWorktreePath: "/tmp/tree" };

  const next = applyRunStatusEvent(answer, frame(view()));

  expect(next.terminals.map((run: RunView) => run.terminalId)).toEqual(["term_a", "term_old"]);
  // The reader's own tree is not a property of any terminal, and must survive.
  expect(next.sessionWorktreePath).toBe("/tmp/tree");
});

test("the same terminal is replaced rather than duplicated", () => {
  const first = applyRunStatusEvent(undefined, frame(view({ status: "running" })));
  const second = applyRunStatusEvent(first, frame(view({ status: "ready" })));

  expect(second.terminals).toHaveLength(1);
  expect(second.terminals[0]?.status).toBe("ready");
});

test("two instances of one recipe are two entries, and one closing leaves the other alone", () => {
  /**
   * "Run = a new terminal": a second press is a second terminal, and nothing
   * about one of them ending says anything about the other.
   */
  const first = applyRunStatusEvent(undefined, frame(view()));
  const both = applyRunStatusEvent(first, frame(view({ terminalId: "term_b", runId: "term_b", title: "dev #2", startedAt: 200 })));
  expect(both.terminals.map((run: RunView) => run.title)).toEqual(["dev #2", "dev"]);

  const closed = applyRunStatusEvent(both, frame(view({ status: "closed", closedBy: "person" })));
  expect(closed.terminals.map((run: RunView) => [run.terminalId, run.status])).toEqual([
    ["term_b", "running"],
    ["term_a", "closed"],
  ]);
});
