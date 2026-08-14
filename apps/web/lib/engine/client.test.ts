// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Turn } from "@telar/engine-client";
import { createEngineApi, newRunId, retryAmbiguousTurn, EngineApiError } from "./client";

describe("engine browser adapter", () => {
  test("uses only standalone /api routes and preserves generated run ids", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createEngineApi(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "run_x" }, replayed: false }, { status: 202 });
    });
    await api.submitTurn("session_a", { runId: "run_stable", input: "hello" });
    expect(calls).toEqual([{ url: "/api/sessions/session_a/turns", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "run_stable", input: "hello" }) } }]);
    expect(newRunId(() => "a-b-c")).toBe("run_abc");
  });

  test("mints a run id on an origin the browser does not call secure", () => {
    /**
     * `crypto.randomUUID` is secure-context only, so it is ABSENT — not
     * restricted, absent — on a page served over plain HTTP from anything but a
     * loopback host. Which is every reader who reaches this cockpit by its
     * address on a network, and the throw landed on the first message of a new
     * conversation.
     */
    const real = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      // The override has to have TAKEN, or this test passes by testing nothing.
      expect(crypto.randomUUID).toBeUndefined();
      const id = newRunId();
      expect(id).toMatch(/^run_[0-9a-f]{32}$/);
      // Still a version 4 UUID underneath, from `getRandomValues` — which has no
      // secure-context restriction — rather than `Math.random`.
      expect(id[16]).toBe("4");
      expect(newRunId()).not.toBe(id);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: real, configurable: true });
    }
  });

  test("keeps a typed unavailable engine state instead of pretending a local fallback worked", async () => {
    const api = createEngineApi(async () => Response.json({ error: { code: "engine_unavailable", message: "not running" } }, { status: 503 }));
    try {
      await api.projects();
      throw new Error("expected api request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineApiError);
      expect((error as EngineApiError).code).toBe("engine_unavailable");
    }
  });

  test("retrying ambiguous work discards it before scheduling an entirely fresh run", async () => {
    const calls: string[] = [];
    await retryAmbiguousTurn(
      {
        discardAmbiguousTurn: async (sessionId, runId) => {
          calls.push(`discard:${sessionId}:${runId}`);
          return { turn: { runId, state: "discarded" } as Turn };
        },
        submitTurn: async (sessionId, input) => {
          calls.push(`submit:${sessionId}:${input.runId}:${input.input}`);
          return {
            turn: { runId: input.runId, state: "queued" } as Turn,
            replayed: false,
          };
        },
      },
      "session_a",
      { runId: "uncertain_run", state: "ambiguous", input: "hello" },
      () => "fresh_run",
    );
    expect(calls).toEqual(["discard:session_a:uncertain_run", "submit:session_a:fresh_run:hello"]);
  });

  test("retry refuses to resolve or replay a turn that is not ambiguous", async () => {
    const calls: string[] = [];
    await expect(retryAmbiguousTurn(
      {
        discardAmbiguousTurn: async () => { calls.push("discard"); return { turn: {} as Turn }; },
        submitTurn: async () => { calls.push("submit"); return { turn: {} as Turn, replayed: false }; },
      },
      "session_a",
      { runId: "run_done", state: "completed", input: "hello" },
    )).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toEqual([]);
  });

  test("discard is an engine-only adapter command and does not submit work", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createEngineApi(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "uncertain_run", state: "discarded" } });
    });
    await api.discardAmbiguousTurn("session_a", "uncertain_run");
    expect(calls).toEqual([{
      url: "/api/sessions/session_a/turns/uncertain_run/discard",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    }]);
  });
});
