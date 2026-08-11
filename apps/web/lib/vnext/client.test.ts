// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineTurn } from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "./client";

describe("vNext browser adapter", () => {
  test("uses only /api/vnext routes and preserves generated run ids", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createVNextApi(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "run_x" }, replayed: false, execution: { status: "scheduled", code: "scheduled" } }, { status: 202 });
    });
    await api.submitTurn("session_a", { runId: "run_stable", text: "hello" });
    expect(calls).toEqual([{ url: "/api/vnext/sessions/session_a/turns", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "run_stable", text: "hello" }) } }]);
    expect(newVNextRunId(() => "a-b-c")).toBe("run_abc");
  });

  test("keeps a typed unavailable engine state instead of pretending a local fallback worked", async () => {
    const api = createVNextApi(async () => Response.json({ error: { code: "engine_unavailable", message: "not running" } }, { status: 503 }));
    try {
      await api.projects();
      throw new Error("expected api request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VNextApiError);
      expect((error as VNextApiError).code).toBe("engine_unavailable");
    }
  });

  test("retrying ambiguous work discards it before scheduling an entirely fresh run", async () => {
    const calls: string[] = [];
    await retryAmbiguousTurn(
      {
        discardAmbiguousTurn: async (sessionId, runId) => {
          calls.push(`discard:${sessionId}:${runId}`);
          return { turn: { runId, state: "discarded" } as EngineTurn };
        },
        submitTurn: async (sessionId, input) => {
          calls.push(`submit:${sessionId}:${input.runId}:${input.text}`);
          return {
            turn: { runId: input.runId, state: "queued" } as EngineTurn,
            replayed: false,
            execution: { status: "scheduled", code: "scheduled" },
          };
        },
      },
      "session_a",
      { runId: "uncertain_run", state: "ambiguous", text: "hello" },
      () => "fresh_run",
    );
    expect(calls).toEqual(["discard:session_a:uncertain_run", "submit:session_a:fresh_run:hello"]);
  });

  test("retry refuses to resolve or replay a turn that is not ambiguous", async () => {
    const calls: string[] = [];
    await expect(retryAmbiguousTurn(
      {
        discardAmbiguousTurn: async () => { calls.push("discard"); return { turn: {} as EngineTurn }; },
        submitTurn: async () => { calls.push("submit"); return { turn: {} as EngineTurn, replayed: false, execution: { status: "scheduled", code: "scheduled" } }; },
      },
      "session_a",
      { runId: "run_done", state: "completed", text: "hello" },
    )).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toEqual([]);
  });

  test("discard is a vNext-only adapter command and does not submit work", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createVNextApi(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "uncertain_run", state: "discarded" } });
    });
    await api.discardAmbiguousTurn("session_a", "uncertain_run");
    expect(calls).toEqual([{
      url: "/api/vnext/sessions/session_a/turns/uncertain_run/discard",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    }]);
  });
});
