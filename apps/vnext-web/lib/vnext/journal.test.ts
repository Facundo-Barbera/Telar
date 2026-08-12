// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { appendJournalEvents, isActiveTurn, journalCursor, projectJournal } from "./journal";

const turn = {
  runId: "run_1",
  sequence: 1,
  text: "Please help",
  state: "running" as const,
  acceptedAt: 1,
  updatedAt: 1,
};

describe("vNext durable journal projection", () => {
  test("hydrates and tails by cursor without duplicating streamed text", () => {
    const initial = [{ id: 1, at: 1, type: "turn.text" as const, runId: "run_1", data: { text: "Hel" } }];
    const merged = appendJournalEvents(initial, [...initial, { id: 2, at: 2, type: "turn.text", runId: "run_1", data: { text: "lo" } }]);
    expect(journalCursor(merged)).toBe(2);
    expect(projectJournal([turn], merged)).toEqual([{ runId: "run_1", prompt: "Please help", text: "Hello", state: "running", failure: undefined }]);
  });

  test("projects recovery and terminal states visibly", () => {
    expect(isActiveTurn("running")).toBe(true);
    expect(isActiveTurn("ambiguous")).toBe(false);
    expect(projectJournal([{ ...turn, state: "ambiguous" }], []).at(0)?.state).toBe("ambiguous");
    expect(projectJournal([{ ...turn, state: "stopped" }], []).at(0)?.state).toBe("stopped");
    expect(projectJournal([{ ...turn, state: "failed", failure: { code: "driver_failed", message: "boom" } }], []).at(0)?.failure).toBe("boom");
    expect(projectJournal([{ ...turn, state: "completed", result: { text: "done" } }], []).at(0)?.text).toBe("done");
    expect(projectJournal([{ ...turn, state: "ambiguous" }], [{ id: 2, at: 2, type: "turn.discarded", runId: "run_1", data: { decision: "discarded" } }]).at(0)?.state).toBe("discarded");
  });

  test("projects every durable queue transition without waiting for a snapshot", () => {
    const states = projectJournal([{ ...turn, state: "queued" }], [
      { id: 1, at: 1, type: "turn.accepted", runId: "run_1", data: { sequence: 1 } },
      { id: 2, at: 2, type: "turn.claimed", runId: "run_1", data: { workerId: "worker_1" } },
      { id: 3, at: 3, type: "turn.running", runId: "run_1", data: {} },
      { id: 4, at: 4, type: "turn.error", runId: "run_1", data: { code: "driver_failed", message: "boom" } },
      { id: 5, at: 5, type: "turn.requeued", runId: "run_1", data: {} },
      { id: 6, at: 6, type: "turn.final", runId: "run_1", data: { text: "done" } },
    ]);
    expect(states).toEqual([{ runId: "run_1", prompt: "Please help", text: "done", state: "completed", failure: "boom" }]);
  });
});
