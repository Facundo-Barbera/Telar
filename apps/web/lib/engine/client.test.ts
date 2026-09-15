// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Turn } from "@telar/engine-client";
import { continueAfterAmbiguousTurn, createEngineApi, newRunId, retryAmbiguousTurn, EngineApiError, OPEN_BUDGET, READ_BUDGET } from "./client";
import { SessionConnection } from "./session-connection";

/**
 * A wire that counts how many requests are on it AT ONCE — the only number the
 * browser's six-per-origin cap is about. Each call takes a macrotask, so an
 * over-budget caller is genuinely made to wait rather than merely interleaved.
 */
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

  test("continuing releases the held run and submits NOTHING — the prompt is never resent", async () => {
    /**
     * The recovery card's primary verb. It is a discard and only a discard:
     * that clears the engine's held dispatch, and the transcript, the provider
     * cursor and the record of the interruption all stay exactly where they
     * are. Whatever runs next is what the person types.
     */
    const calls: string[] = [];
    await continueAfterAmbiguousTurn(
      {
        discardAmbiguousTurn: async (sessionId: string, runId: string) => {
          calls.push(`discard:${sessionId}:${runId}`);
          return { turn: { runId, state: "discarded" } as Turn };
        },
      },
      "session_a",
      { runId: "uncertain_run", state: "ambiguous" },
    );
    // A discard and nothing else. The signature does not even offer `submitTurn`,
    // so "Continue resends the prompt" is not a regression that can be written.
    expect(calls).toEqual(["discard:session_a:uncertain_run"]);
  });

  test("continue refuses a turn that is not ambiguous", async () => {
    await expect(
      continueAfterAmbiguousTurn(
        { discardAmbiguousTurn: async () => ({ turn: {} as Turn }) },
        "session_a",
        { runId: "run_done", state: "completed" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
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

  test("background reads never spend more than the connection budget (#82)", async () => {
    const wire = countingWire();
    const api = createEngineApi(wire.fetcher);
    // Six reads asked for at one instant — the shape of a rail pass landing
    // across an open cockpit's tail, and exactly the cap it used to fill.
    await Promise.all([api.health(), api.projects(), api.inbox(), api.hosts(), api.orientation(), api.sidebarLayout()]);
    expect(wire.peak).toBe(READ_BUDGET);
    // Every one of them still happened; the budget delays, it never drops.
    expect(wire.urls).toHaveLength(6);
  });

  test("the opening read never waits behind the polls (#497)", async () => {
    /**
     * THE THREE SERIAL ROUND TRIPS #490's audit measured, in a fixture.
     *
     * Opening a conversation issued `/bootstrap` beside the cockpit's
     * `/projects` and the rail's own pass. Three reads, two slots — and nothing
     * ordered them, so the one a person was waiting on could be the one that
     * queued. `/bootstrap` spends `OPEN_BUDGET` now, which no poll can take.
     */
    const wire = countingWire((pathname) =>
      pathname.includes("/bootstrap")
        ? { session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 3, events: [], subscriptions: [] }
        : {},
    );
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.health(), api.projects(), api.sessionBootstrap("session_1", { turns: 10 })]);
    // FIRST WAVE, not third. The two polls filled the ordinary budget and the
    // open went out anyway.
    expect(wire.urls.slice(0, 3)).toContain("/api/sessions/session_1/bootstrap?turns=10");
    expect(wire.peak).toBe(READ_BUDGET + OPEN_BUDGET);
    // …and #82's arithmetic still holds: six per origin, minus the three this
    // cockpit can now spend, leaves three for navigation, which needs one.
    expect(6 - wire.peak).toBeGreaterThanOrEqual(3);
  });

  test("the opening's slot is its own, and ordinary reads cannot take it (#497)", async () => {
    /**
     * The other half of "its own slot": a lane of one that only `/bootstrap`
     * may enter. Six polls at one instant still peak at two, so the extra slot
     * is not a third read for everybody — it sits idle unless a conversation is
     * opening.
     */
    const wire = countingWire();
    const api = createEngineApi(wire.fetcher);
    await Promise.all([api.health(), api.projects(), api.inbox(), api.hosts(), api.orientation(), api.sidebarLayout()]);
    expect(wire.peak).toBe(READ_BUDGET);
  });

  test("two conversations opening at once still take one slot between them (#497)", async () => {
    /**
     * WHY THE OPEN LANE IS ONE AND NOT MORE. A person opens one conversation at
     * a time, and the rail's warm-ups coalesce onto the same `SessionConnection`
     * the cockpit reads — so the pathological case is a second opening arriving
     * mid-first, which queues rather than doubling the engine's work.
     */
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
      // THE FIRST TWO THROW while holding the only two slots. A gate that let
      // go of a slot only on success would deadlock every read behind them —
      // the cockpit would go quiet under exactly the engine outage it is
      // supposed to survive.
      if (String(url) === "/api/health") throw new Error("socket died");
      return Response.json({});
    }) as unknown as typeof fetch);
    const results = await Promise.allSettled([api.health(), api.health(), api.projects(), api.inbox(), api.hosts()]);
    expect(peak).toBe(READ_BUDGET);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    // FIFO: the two that were asked for first went out first, and the rest
    // followed in the order their callers queued.
    expect(order).toEqual(["/api/health", "/api/health", "/api/projects", "/api/inbox", "/api/hosts"]);
  });

  test("a mutation never waits behind background reads", async () => {
    const wire = countingWire(() => ({ turn: { runId: "run_x" }, replayed: false }));
    const api = createEngineApi(wire.fetcher);
    // Two reads fill the budget; the click must go out anyway, not third.
    const sent = Promise.all([api.health(), api.projects(), api.submitTurn("session_a", { runId: "run_1", input: "hello" })]);
    await sent;
    expect(wire.urls.slice(0, 3)).toContain("/api/sessions/session_a/turns");
    expect(wire.peak).toBe(READ_BUDGET + 1);
  });

  test("one open cockpit leaves four connections free for navigation (#82)", async () => {
    /**
     * THE FIXTURE THE BUDGET IS FOR. A cockpit sitting on a working session
     * holds its own tail once a second while the rail fans out around it; the
     * measured freeze was that burst reaching six. Counted here over a full
     * second's worth of work: the opening read, three tail ticks, and a rail
     * pass landing across them.
     */
    const wire = countingWire((pathname) => {
      if (pathname.includes("/bootstrap")) {
        return { session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 3, events: [], subscriptions: [] };
      }
      // A quiet tick: the tail asks the journal and is told nothing happened,
      // so no companion snapshot is fetched and the tick costs ONE request.
      return pathname.includes("/events") ? { events: [] } : {};
    });
    const api = createEngineApi(wire.fetcher);
    const cockpit = new SessionConnection(api, "session_1", { turns: 10 });
    await cockpit.read();
    await Promise.all([
      cockpit.read(),
      cockpit.read(),
      cockpit.read(),
      // The rail's own pass, which is where the concurrency actually came from.
      api.liveSessions(),
      api.health(),
      api.inbox(),
    ]);
    expect(wire.peak).toBeLessThanOrEqual(READ_BUDGET);
    // The number the issue is written in: six per origin, minus what the
    // cockpit spends, is what an App Router navigation has left to fetch with.
    expect(6 - wire.peak).toBeGreaterThanOrEqual(4);
    // And the tail itself is ONE read a tick — the three concurrent reads above
    // coalesce onto the single in-flight hydration, as they always have.
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
