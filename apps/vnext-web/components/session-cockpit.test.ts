// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeTurnState, retryInputForJournalTurn } from "./session-cockpit";

describe("vNext session workspace presentation", () => {
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
