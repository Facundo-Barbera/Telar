import { describe, expect, test } from "bun:test";
import type { Session, Turn } from "@telar/engine-client";
import { emptySessionData, sessionDataReducer, type SessionData } from "./session-data";

const turn = (runId: string, state = "completed") => ({ runId, state }) as unknown as Turn;
const session = (id: string) => ({ id }) as unknown as Session;

describe("sessionDataReducer", () => {
  test("a cached replace keeps the landed read key; a hydrate sets it", () => {
    const landed = { ...emptySessionData, readKey: "a" };
    expect(sessionDataReducer(landed, { type: "replace", data: { ...emptySessionData, session: session("s") } }).readKey).toBe("a");
    expect(sessionDataReducer(landed, { type: "replace", data: emptySessionData, readKey: "b" }).readKey).toBe("b");
  });

  test("a tail merges rows by id and an older page goes in front", () => {
    const state: SessionData = { ...emptySessionData, turns: [turn("1"), turn("2", "running")] };
    const tailed = sessionDataReducer(state, {
      type: "tail",
      data: { session: session("s"), turns: [turn("2"), turn("3")], items: [], tasks: [], requests: [], events: [] },
    });
    expect(tailed.turns.map((entry) => [entry.runId, entry.state])).toEqual([["1", "completed"], ["2", "completed"], ["3", "completed"]]);
    const older = sessionDataReducer(tailed, { type: "older", data: { turns: [turn("0")], items: [], tasks: [], page: { more: false } as SessionData["page"] } });
    expect(older.turns.map((entry) => entry.runId)).toEqual(["0", "1", "2", "3"]);
  });

  test("a session update that returns the same record keeps the state", () => {
    const state = { ...emptySessionData, session: session("s") };
    expect(sessionDataReducer(state, { type: "session", next: (current) => current })).toBe(state);
    expect(sessionDataReducer(state, { type: "session", next: session("t") }).session?.id).toBe("t");
  });
});
