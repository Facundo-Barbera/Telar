import { describe, expect, test } from "bun:test";
import { createEngineApi, newRunId, EngineApiError, OPEN_BUDGET, READ_BUDGET } from "./client";
import { SessionConnection } from "./session-connection";

/** Counts concurrent requests; each call yields a macrotask so over-budget callers really wait. */
function countingWire(answer: (pathname: string) => unknown = () => ({})) {
  let live = 0;
  let peak = 0;
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const pathname = String(url);
    urls.push(pathname);
    live += 1;
    peak = Math.max(peak, live);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    live -= 1;
    return Response.json(answer(pathname) as Record<string, unknown>);
  }) as unknown as typeof fetch;
  return { fetcher, urls, get peak() { return peak; } };
}

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
    // `crypto.randomUUID` is absent off a secure context (plain HTTP, non-loopback).
    const real = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(crypto.randomUUID).toBeUndefined();
      const id = newRunId();
      expect(id).toMatch(/^run_[0-9a-f]{32}$/);
      // Still a v4 UUID, from `getRandomValues`, which works in insecure contexts.
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

  test("background reads never spend more than the connection budget (#82)", async () => {
    const wire = countingWire();
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.health(), api.projects(), api.inbox(), api.hosts(), api.orientation(), api.sidebarLayout()]);
    expect(wire.peak).toBe(READ_BUDGET);
    expect(wire.urls).toHaveLength(6);
  });

  test("the opening read never waits behind the polls (#497)", async () => {
    const wire = countingWire((pathname) =>
      pathname.includes("/bootstrap")
        ? { session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 3, events: [], subscriptions: [] }
        : {},
    );
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.health(), api.projects(), api.sessionBootstrap("session_1", { turns: 10 })]);
    expect(wire.urls.slice(0, 3)).toContain("/api/sessions/session_1/bootstrap?turns=10");
    expect(wire.peak).toBe(READ_BUDGET + OPEN_BUDGET);
    // Six per origin minus what this cockpit can spend leaves three for navigation.
    expect(6 - wire.peak).toBeGreaterThanOrEqual(3);
  });

  test("the opening's slot is its own, and ordinary reads cannot take it (#497)", async () => {
    // The open lane is reserved for `/bootstrap`; polls cannot take it.
    const wire = countingWire();
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.health(), api.projects(), api.inbox(), api.hosts(), api.orientation(), api.sidebarLayout()]);
    expect(wire.peak).toBe(READ_BUDGET);
  });

  test("two conversations opening at once still take one slot between them (#497)", async () => {
    const wire = countingWire((pathname) => ({
      session: { id: pathname.includes("session_2") ? "session_2" : "session_1" },
      turns: [], items: [], tasks: [], requests: [], cursor: 1, events: [], subscriptions: [],
    }));
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.sessionBootstrap("session_1"), api.sessionBootstrap("session_2")]);
    expect(wire.peak).toBe(OPEN_BUDGET);
    expect(wire.urls).toHaveLength(2);
  });

  test("the budget queues in order and a failed read gives its slot back", async () => {
    let live = 0;
    let peak = 0;
    const order: string[] = [];
    const api = createEngineApi((async (url: string) => {
      live += 1;
      peak = Math.max(peak, live);
      order.push(String(url));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      live -= 1;
      // These two throw while holding both slots; a gate freeing slots only on success would deadlock.
      if (String(url) === "/api/health") throw new Error("socket died");
      return Response.json({});
    }) as unknown as typeof fetch);
    const results = await Promise.allSettled([api.health(), api.health(), api.projects(), api.inbox(), api.hosts()]);
    expect(peak).toBe(READ_BUDGET);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect(order).toEqual(["/api/health", "/api/health", "/api/projects", "/api/inbox", "/api/hosts"]);
  });

  test("a mutation never waits behind background reads", async () => {
    const wire = countingWire(() => ({ turn: { runId: "run_x" }, replayed: false }));
    const api = createEngineApi(wire.fetcher);
    const sent = Promise.all([api.health(), api.projects(), api.submitTurn("session_a", { runId: "run_1", input: "hello" })]);
    await sent;
    expect(wire.urls.slice(0, 3)).toContain("/api/sessions/session_a/turns");
    expect(wire.peak).toBe(READ_BUDGET + 1);
  });

  test("one open cockpit leaves four connections free for navigation (#82)", async () => {
    const wire = countingWire((pathname) => {
      if (pathname.includes("/bootstrap")) {
        return { session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 3, events: [], subscriptions: [] };
      }
      // A quiet tick costs one request: no companion snapshot.
      return pathname.includes("/events") ? { events: [] } : {};
    });
    const api = createEngineApi(wire.fetcher);
    const cockpit = new SessionConnection(api, "session_1", { turns: 10 });
    await cockpit.read();
    await Promise.all([
      cockpit.read(),
      cockpit.read(),
      cockpit.read(),
      api.liveSessions(),
      api.health(),
      api.inbox(),
    ]);
    expect(wire.peak).toBeLessThanOrEqual(READ_BUDGET);
    expect(6 - wire.peak).toBeGreaterThanOrEqual(4);
    // Concurrent reads coalesce onto one in-flight hydration.
    expect(wire.urls.filter((url) => url.includes("session_1")).length).toBeLessThanOrEqual(2);
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
