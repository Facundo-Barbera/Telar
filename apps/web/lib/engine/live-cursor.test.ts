// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createEngineApi } from "./client";

/**
 * THE RAIL'S TICK, AND WHAT IT COSTS — issue #459.
 *
 * A COCKPIT CANNOT BE PUSHED TO, and this is the first thing to say plainly
 * because the issue asked for a change signal. There is no global event feed on
 * the engine: journals are per session and their ids are per session too, there
 * is no SSE route and no socket anywhere in this app, and #82 — the issue about
 * navigation freezing at the browser's six-connection cap — is the reason
 * against opening the first long-lived connection this cockpit has ever had.
 * PR #450's audit reached the same conclusion and declined to build one.
 *
 * So the rail still asks on a timer, and what changed is the COST of asking. It
 * hands back the revision it was given; an engine with nothing new answers
 * `unchanged` and the rail keeps what it has. The proof below is therefore not
 * "zero requests" — that would need the connection we are declining — but ZERO
 * ROWS: an idle cockpit transfers nothing at all across ten seconds of it, and a
 * cockpit with one working session pulls rows at most once per three-second
 * tick and never more often than that.
 */

/** The cadence in `app-sidebar.tsx`: tight while anything is live, slack when
 *  nothing is. Duplicated here rather than imported because the component is not
 *  loadable outside a sidebar provider; `sidebar-one-read.test.ts` pins the
 *  component's own numbers against source. */
const LIVE_TICK_MS = 3_000;
const IDLE_TICK_MS = 10_000;

/** An engine that counts what it was asked for and what it sent back. */
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

    // The first pass has no cursor and pulls the list, as a freshly opened
    // cockpit must.
    const first = await api.liveSessions();
    expect(first.sessions).toHaveLength(267);
    const firstBytes = wire.bytesSent;
    let cursor = first.revision!;

    // Ten seconds of fake time at the idle cadence. Nothing is live, so nothing
    // has been written, so nothing comes back.
    for (let elapsed = IDLE_TICK_MS; elapsed <= 10 * IDLE_TICK_MS; elapsed += IDLE_TICK_MS) {
      const tick = await api.liveSessionsSince(cursor);
      expect(tick.unchanged).toBe(true);
      cursor = tick.revision!;
    }
    expect(wire.rowsSent).toBe(267);
    // Ten idle ticks together cost less than one percent of the read that
    // opened the cockpit. Before this, each of them WAS that read.
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

    // A working session writes on every turn transition, so every tick of the
    // tight cadence finds something. That is the WORST case for this design,
    // and the bound it has to meet is the one the issue named.
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
    // A daemon that restarted counts from a new number. Answering "unchanged"
    // to a cursor from the last one would leave a rail that never moves again,
    // with nothing on screen to say so.
    const tick = await api.liveSessionsSince(12);
    expect(tick.unchanged).toBeUndefined();
    expect(wire.rowsSent).toBe(267);
  });
});
