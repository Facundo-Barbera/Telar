// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createEngineApi } from "./client";

/**
 * There is no push channel (the browser's six-connection cap argues against one),
 * so the rail polls with a revision cursor: idle ticks transfer no rows, and a
 * live session pulls at most once per tick.
 */

/** Mirrors `app-sidebar.tsx`, which can't load outside a sidebar provider;
 *  `sidebar-one-read.test.ts` pins the component's own numbers. */
const LIVE_TICK_MS = 3_000;
const IDLE_TICK_MS = 10_000;

function engine(options: { revision: number }) {
  const wire = { reads: 0, rowsSent: 0, bytesSent: 0 };
  let revision = options.revision;
  const rows = Array.from({ length: 267 }, (_, index) => ({
    id: `session_${index}`,
    title: "Lean the live list",
    state: "active",
    activity: "idle",
    createdAt: 1,
    updatedAt: 1,
    driver: "claude",
    envMode: "worktree",
    workspace: { mode: "worktree", path: "/tmp/w", branch: "telar/459" },
  }));
  const api = createEngineApi(async (url) => {
    wire.reads += 1;
    const since = new URL(String(url), "http://cockpit.test").searchParams.get("since");
    const body =
      since !== null && Number(since) === revision
        ? { unchanged: true, revision, daemonId: "daemon_one" }
        : { sessions: rows, projects: [], daemonId: "daemon_one", revision };
    if (!("unchanged" in body)) wire.rowsSent += rows.length;
    wire.bytesSent += JSON.stringify(body).length;
    return Response.json(body);
  });
  return { api, wire, move: () => { revision += 1; } };
}

describe("the rail's conditional read", () => {
  test("an idle cockpit transfers zero rows across ten seconds of ticks", async () => {
    const { api, wire, move } = engine({ revision: 41 });
    void move;

    const first = await api.liveSessions();
    expect(first.sessions).toHaveLength(267);
    const firstBytes = wire.bytesSent;
    let cursor = first.revision!;

    for (let elapsed = IDLE_TICK_MS; elapsed <= 10 * IDLE_TICK_MS; elapsed += IDLE_TICK_MS) {
      const tick = await api.liveSessionsSince(cursor);
      expect(tick.unchanged).toBe(true);
      cursor = tick.revision!;
    }
    expect(wire.rowsSent).toBe(267);
    expect(wire.bytesSent - firstBytes).toBeLessThan(firstBytes / 100);
  });

  test("the engine's identity still rides an unchanged answer, so nothing goes back to health()", async () => {
    const { api } = engine({ revision: 7 });
    const tick = await api.liveSessionsSince(7);
    expect(tick.unchanged).toBe(true);
    expect(tick.daemonId).toBe("daemon_one");
  });

  test("one live session pulls rows at most once per three-second tick", async () => {
    const { api, wire, move } = engine({ revision: 100 });
    let cursor = (await api.liveSessions()).revision!;
    const opening = wire.reads;

    // Worst case: a working session writes on every turn transition.
    let elapsed = 0;
    let pulls = 0;
    while (elapsed < 30_000) {
      move();
      const tick = await api.liveSessionsSince(cursor);
      if (!tick.unchanged) pulls += 1;
      cursor = tick.revision!;
      elapsed += LIVE_TICK_MS;
    }
    expect(wire.reads - opening).toBe(30_000 / LIVE_TICK_MS);
    expect(pulls).toBeLessThanOrEqual(30_000 / LIVE_TICK_MS);
  });

  test("a cursor the engine does not recognise pulls the list rather than freezing the rail", async () => {
    const { api, wire } = engine({ revision: 900 });
    // A restarted daemon counts from a new number; "unchanged" would freeze the rail.
    const tick = await api.liveSessionsSince(12);
    expect(tick.unchanged).toBeUndefined();
    expect(wire.rowsSent).toBe(267);
  });
});
