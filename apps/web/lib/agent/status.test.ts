/**
 * WHAT THE RAIL'S AGENT ROW SAYS UNDERNEATH ITS NAME (#539).
 *
 * THE LADDER IS THE TEST, and its order is not alphabetical. A parked approval
 * outranks everything because it is the only one of these a person can DO
 * something about — a row saying "working" while the Agent sat waiting for an
 * answer would be the machine hiding the one thing that needed them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { AgentRequest, AgentState } from "@telar/engine-client";
import { agentStatus } from "./status";

const idle: AgentState = { enabled: true, running: false, queued: 0 };
const request: AgentRequest = {
  type: "approval",
  id: "req_one",
  runId: "run_one",
  tool: "sessions_send",
  args: {},
  toolCallId: "call_one",
  reason: "It wants to assign work to another session.",
  openedAt: 1,
};

describe("the status ladder", () => {
  test("waiting for a person beats everything, including a queue behind it", () => {
    expect(agentStatus({ ...idle, request })).toEqual({ label: "waiting for you", tone: "waiting" });
    // The engine reports `running: false` while a turn is parked, but a build
    // that ever reported both must still show the one a person can act on.
    expect(agentStatus({ ...idle, request, running: true, queued: 3 }).label).toBe("waiting for you");
  });

  test("working, then what is waiting behind it", () => {
    expect(agentStatus({ ...idle, running: true })).toEqual({ label: "working", tone: "working" });
    expect(agentStatus({ ...idle, queued: 1 })).toEqual({ label: "1 queued", tone: "working" });
    expect(agentStatus({ ...idle, queued: 4 }).label).toBe("4 queued");
  });

  test("a quiet Agent says what the last turn cost", () => {
    const state: AgentState = { ...idle, lastUsage: { runId: "run_a", at: 1, usage: { input: 2_600, output: 90, total: 2_690 }, contextChars: 30_000, budgetChars: 120_000 } };
    expect(agentStatus(state)).toEqual({ label: "2,690 tokens last turn", tone: "idle" });
  });

  test("a provider that reported no tokens says idle rather than zero", () => {
    // ABSENT IS NOT ZERO. "0 tokens last turn" would be a claim nobody made.
    const state: AgentState = { ...idle, lastUsage: { runId: "run_a", at: 1, contextChars: 30_000, budgetChars: 120_000 } };
    expect(agentStatus(state)).toEqual({ label: "idle", tone: "idle" });
  });

  test("plain idle before anything has happened, and a placeholder before the engine answers", () => {
    expect(agentStatus(idle)).toEqual({ label: "idle", tone: "idle" });
    // Nothing has answered yet: the row is already drawn (the live read's flag
    // put it there), so it needs a line, and the line must not assert "idle"
    // about a Mac that may be mid-turn.
    expect(agentStatus(undefined)).toEqual({ label: "…", tone: "idle" });
  });
});
