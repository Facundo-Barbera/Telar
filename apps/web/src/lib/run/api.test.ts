/**
 * The wire, with a fake fetcher: paths, methods, and the two bodies whose shape
 * is load-bearing — `replace` (a takeover the human must have asked for) and
 * `after` (the output cursor).
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { EngineApiError } from "@/lib/engine/client";
import { createRunApi, runPath } from "./api";

type Call = { url: string; method?: string; body?: unknown };

function recorder(response: unknown = {}, status = 200) {
  const calls: Call[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, api: createRunApi(fetcher) };
}

describe("runPath", () => {
  test("is session-scoped and encodes what it is given", () => {
    // The project and the worktree come from the session on the daemon side; a
    // client that could name a project could stop another project's server.
    expect(runPath("sess_1", "/status")).toBe("/api/sessions/sess_1/run/status");
    expect(runPath("a/b", "/start")).toBe("/api/sessions/a%2Fb/run/start");
  });

  test("undefined query values are omitted rather than sent as the string", () => {
    expect(runPath("s", "/output", { runId: undefined, after: 0 })).toBe("/api/sessions/s/run/output?after=0");
  });
});

describe("createRunApi", () => {
  test("start names only the configuration — every start opens a new terminal", () => {
    const { calls, api } = recorder();
    void api.start("sess_1", "cfg_1");
    expect(calls[0]).toEqual({ url: "/api/sessions/sess_1/run/start", method: "POST", body: { configId: "cfg_1" } });
  });

  test("stop and restart name the terminal, or leave it to the session's one open terminal", () => {
    const { calls, api } = recorder();
    void api.stop("sess_1");
    void api.restart("sess_1", "term_9");
    expect(calls[0]).toEqual({ url: "/api/sessions/sess_1/run/stop", method: "POST", body: {} });
    expect(calls[1]!.body).toEqual({ terminalId: "term_9" });
  });

  test("output carries the cursor as a query parameter", () => {
    const { calls, api } = recorder({ lines: [], cursor: 0, dropped: 0 });
    void api.output("sess_1", { after: 42 });
    expect(calls[0]!.url).toBe("/api/sessions/sess_1/run/output?after=42");
    expect(calls[0]!.method).toBe("GET");
  });

  test("configuration edits address the config by id", () => {
    const { calls, api } = recorder();
    void api.updateConfiguration("sess_1", "cfg 1", { command: "bun run dev" });
    void api.removeConfiguration("sess_1", "cfg 1");
    expect(calls[0]!.url).toBe("/api/sessions/sess_1/run/configs/cfg%201");
    expect(calls[1]!.method).toBe("DELETE");
  });

  test("a refusal arrives as EngineApiError with the engine's own code", async () => {
    // Components branch on `conflict` — it is how "already deployed" and "lost
    // contact with the last one" both reach the button.
    const { api } = recorder({ error: { code: "conflict", message: "this project is already deployed" } }, 409);
    await expect(api.start("sess_1", "cfg_1")).rejects.toBeInstanceOf(EngineApiError);
    await api.start("sess_1", "cfg_1").catch((error: EngineApiError) => {
      expect(error.code).toBe("conflict");
      expect(error.status).toBe(409);
      expect(error.message).toContain("already deployed");
    });
  });

  test("an adapter that is not there is not reported as a run failure", async () => {
    const fetcher = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    await createRunApi(fetcher)
      .status("sess_1")
      .catch((error: EngineApiError) => expect(error.code).toBe("engine_unavailable"));
  });
});
