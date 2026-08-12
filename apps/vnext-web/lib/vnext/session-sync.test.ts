// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineSession, EngineTurn } from "@telar/engine-client";
import { hydrateVNextSession, needsSessionSnapshot, tailVNextSession } from "./session-sync";

const session: EngineSession = {
  id: "session_1", projectId: "project_1", title: "Test", createdAt: 1, updatedAt: 1, provider: { kind: "claude" },
};
const turn: EngineTurn = { runId: "run_1", sequence: 1, text: "Prompt", state: "queued", acceptedAt: 1, updatedAt: 1 };
const accepted: EngineEvent = { id: 1, at: 1, type: "turn.accepted", runId: "run_1", data: { sequence: 1 } };
const running: EngineEvent = { id: 2, at: 2, type: "turn.running", runId: "run_1", data: {} };

describe("vNext session hydration", () => {
  test("closes the snapshot/journal gap without dropping a running transition", async () => {
    const calls: string[] = [];
    const api = {
      events: async (_sessionId: string, after: number) => {
        calls.push(`events:${after}`);
        return after === 0 ? { events: [accepted] } : { events: [running] };
      },
      session: async () => {
        calls.push("session");
        return { session, turns: [{ ...turn, state: "running" as const }] };
      },
    };
    const result = await hydrateVNextSession(api, session.id);
    expect(calls).toEqual(["events:0", "session", "events:1", "session"]);
    expect(result.events).toEqual([accepted, running]);
    expect(result.turns).toEqual([{ ...turn, state: "running" }]);
    expect(result.cursor).toBe(2);
  });

  test("refreshes the companion snapshot for every queue state event", async () => {
    expect(needsSessionSnapshot([accepted])).toBeTrue();
    expect(needsSessionSnapshot([running])).toBeTrue();
    expect(needsSessionSnapshot([{ id: 3, at: 3, type: "turn.final", runId: "run_1", data: { text: "done" } }])).toBeTrue();
    expect(needsSessionSnapshot([{ id: 4, at: 4, type: "turn.text", runId: "run_1", data: { text: "x" } }])).toBeFalse();

    const result = await tailVNextSession({
      events: async () => ({ events: [running] }),
      session: async () => ({ session, turns: [{ ...turn, state: "running" as const }] }),
    }, session.id, 1);
    expect(result.snapshot?.turns.at(0)?.state).toBe("running");
    expect(result.cursor).toBe(2);
  });
});
