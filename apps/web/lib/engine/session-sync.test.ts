// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Session, Turn } from "@telar/engine-client";
import { hydrateSession, needsSessionSnapshot, tailSession } from "./session-sync";

const session: Session = {
  id: "session_1",
  projectId: "project_1",
  environmentId: "local",
  title: "Test",
  state: "active",
  createdAt: 1,
  updatedAt: 1,
  providerInstanceId: "claude:default",
  driver: "claude",
  workspace: { mode: "local", path: "/repo" },
  envMode: "local",
  runtimeMode: "auto",
  interactionMode: "default",
  detached: true,
  activity: "idle",
};
const turn: Turn = {
  runId: "run_1",
  sessionId: "session_1",
  sequence: 1,
  input: "Prompt",
  state: "queued",
  acceptedAt: 1,
  updatedAt: 1,
};
const items: Item[] = [];
const envelope = { at: 1, sessionId: "session_1", runId: "run_1" } as const;
const accepted: EngineEvent = { ...envelope, id: 1, type: "turn.accepted", turn, replayed: false };
const started: EngineEvent = { ...envelope, id: 2, at: 2, type: "turn.started" };

describe("session hydration", () => {
  test("opens on the snapshot and tails from its cursor — never from zero", async () => {
    const calls: string[] = [];
    const api = {
      events: async (_sessionId: string, after: number) => {
        calls.push(`events:${after}`);
        return { events: after === 0 ? [accepted, started] : [started] };
      },
      session: async () => {
        calls.push("session");
        return { cursor: 1, session, turns: [{ ...turn, state: "running" as const }], items, requests: [], tasks: [] };
      },
    };
    const result = await hydrateSession(api, session.id);
    expect(calls).toEqual(["session", "events:1"]);
    expect(result.events).toEqual([started]);
    expect(result.turns).toEqual([{ ...turn, state: "running" }]);
    expect(result.cursor).toBe(2);
  });

  test("a quiet session's cursor is the snapshot's, not zero", async () => {
    // Nothing after the stamp: the next tail must ask from 7, not restart.
    const result = await hydrateSession(
      {
        events: async () => ({ events: [] }),
        session: async () => ({ cursor: 7, session, turns: [], items, requests: [], tasks: [] }),
      },
      session.id,
    );
    expect(result.cursor).toBe(7);
  });

  test("an engine without the stamp falls back to asking the journal where it ends", async () => {
    const calls: string[] = [];
    const api = {
      events: async (_sessionId: string, after: number) => {
        calls.push(`events:${after}`);
        return { events: after === 0 ? [accepted, started] : [] };
      },
      session: async () => {
        calls.push("session");
        return { session, turns: [turn], items, requests: [], tasks: [] };
      },
    };
    const result = await hydrateSession(api, session.id);
    expect(calls).toEqual(["session", "events:0", "events:2"]);
    expect(result.cursor).toBe(2);
  });

  test("refreshes the companion snapshot for every queue state event", async () => {
    expect(needsSessionSnapshot([accepted])).toBeTrue();
    expect(needsSessionSnapshot([started])).toBeTrue();
    expect(
      needsSessionSnapshot([{ ...envelope, id: 3, type: "turn.completed", resultText: "done" }]),
    ).toBeTrue();

    const result = await tailSession(
      {
        events: async () => ({ events: [started] }),
        session: async () => ({ session, turns: [{ ...turn, state: "running" as const }], items, requests: [], tasks: [] }),
      },
      session.id,
      1,
    );
    expect(result.snapshot?.turns.at(0)?.state).toBe("running");
    expect(result.cursor).toBe(2);
  });

  test("high-frequency item and delta events do NOT trigger a snapshot refetch", async () => {
    // The load-bearing half of this predicate. A streaming turn emits one delta
    // per token; refetching a snapshot for each would turn streaming into a
    // request storm for information the event already carried.
    expect(
      needsSessionSnapshot([{ ...envelope, id: 4, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "x" }]),
    ).toBeFalse();
    expect(
      needsSessionSnapshot([
        {
          ...envelope,
          id: 5,
          type: "item.started",
          item: {
            id: "i1",
            runId: "run_1",
            sessionId: "session_1",
            status: "inProgress",
            startedAt: 1,
            detail: { type: "assistant_message", text: "" },
          },
        },
      ]),
    ).toBeFalse();
  });
});
