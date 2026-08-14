// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { turnActivity } from "./transcript";
import { describeTurnState, retryInputForJournalTurn } from "./session-cockpit";

describe("session workspace presentation", () => {
  test("names every durable turn state without relying on colour", () => {
    expect(describeTurnState("queued")).toEqual({ label: "Queued", tone: "active" });
    expect(describeTurnState("claimed")).toEqual({ label: "Claimed", tone: "active" });
    expect(describeTurnState("running")).toEqual({ label: "Streaming", tone: "active" });
    expect(describeTurnState("completed")).toEqual({ label: "Completed", tone: "done" });
    expect(describeTurnState("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(describeTurnState("stopped")).toEqual({ label: "Stopped", tone: "muted" });
  });

  test("keeps recovery state explicit rather than implying a replay", () => {
    expect(describeTurnState("ambiguous")).toEqual({ label: "Needs recovery decision", tone: "attention" });
    expect(describeTurnState("discarded")).toEqual({ label: "Discarded after recovery decision", tone: "muted" });
  });

  test("retries the durable prompt, never streamed agent output", () => {
    expect(retryInputForJournalTurn({
      runId: "uncertain_run",
      state: "ambiguous",
      prompt: "Review this implementation",
    })).toEqual({ runId: "uncertain_run", state: "ambiguous", input: "Review this implementation" });
  });
});

describe("what a live turn says it is doing", () => {
  const turn = (over: Partial<{ items: unknown[]; tasks: unknown[] }> = {}) =>
    ({ items: [], tasks: [], ...over }) as Parameters<typeof turnActivity>[0];
  const task = (over: Record<string, unknown> = {}) =>
    ({ id: "t", sessionId: "s", runId: "r", kind: "agent", state: "running", startedAt: 1, updatedAt: 1, items: [], ...over }) as never;

  test("a fan-out says how many agents are out, not that the main loop is thinking", () => {
    // "Thinking 43s" beside four sub-agent chips describes the machinery rather
    // than the work: the main loop IS idle, and saying so is the least useful
    // true thing available.
    expect(turnActivity(turn({ tasks: [task(), task({ id: "t2" })] }))).toEqual({
      label: "2 sub-agents working",
      delegated: true,
    });
    expect(turnActivity(turn({ tasks: [task()] })).label).toBe("1 sub-agent working");
  });

  test("a finished sub-agent stops speaking for the turn", () => {
    expect(turnActivity(turn({ tasks: [task({ state: "completed" })] })).label).toBe("Thinking");
  });

  test("background work does not claim the main loop is busy", () => {
    // A watch loop running says nothing about what the agent is doing, and it
    // outlives the turn anyway.
    expect(turnActivity(turn({ tasks: [task({ kind: "background" })] })).label).toBe("Thinking");
  });

  test("a running tool is Working; nothing running is Thinking", () => {
    expect(turnActivity(turn({ items: [{ status: "inProgress" }] })).label).toBe("Working");
    expect(turnActivity(turn({ items: [{ status: "completed" }] })).label).toBe("Thinking");
  });
});
