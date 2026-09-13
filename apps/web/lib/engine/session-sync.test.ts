// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Session, SnapshotWindow, Task, Turn } from "@telar/engine-client";
import {
  INITIAL_TURNS,
  OLDER_PAGE_TURNS,
  hydrateSession,
  loadOlderTurns,
  mergeOlderPage,
  mergeRows,
  needsSessionSnapshot,
  tailSession,
} from "./session-sync";

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

  test("an open item's lower prefix watermark does NOT rewind the tail", async () => {
    /**
     * #214. A prefix ending below the cursor looks like a gap and is not: the
     * engine builds it complete through the same cursor it stamps, so a lower
     * watermark only means no delta for that item arrived in between.
     *
     * REWINDING WOULD COST MORE THAN IT SAVED. The events between the two are
     * not only deltas — `item.completed` for a row that closed, turn
     * transitions — and replaying those onto a snapshot that already reflects
     * them is a far larger claim than dropping a duplicate delta. Dedupe by
     * event id does not establish it.
     */
    const asked: number[] = [];
    const open: Item = {
      id: "i1",
      runId: "run_1",
      sessionId: "session_1",
      status: "inProgress",
      startedAt: 1,
      detail: { type: "assistant_message", text: "" },
      streamed: "Once upon ",
      streamedThrough: 4,
    };
    await hydrateSession(
      {
        events: async (_sessionId: string, after: number) => {
          asked.push(after);
          return { events: [] };
        },
        session: async () => ({ cursor: 9, session, turns: [turn], items: [open], requests: [], tasks: [] }),
      },
      session.id,
    );
    expect(asked).toEqual([9]);
  });

  test("a closed item's leftover prefix changes nothing", async () => {
    // Its text is authoritative in `detail` from the moment it closed, so a
    // stale `streamed` beside it is inert rather than a second opinion.
    const asked: number[] = [];
    const closed: Item = {
      id: "i1",
      runId: "run_1",
      sessionId: "session_1",
      status: "completed",
      startedAt: 1,
      detail: { type: "assistant_message", text: "Once upon a time" },
      streamed: "Once upon ",
      streamedThrough: 4,
    };
    await hydrateSession(
      {
        events: async (_sessionId: string, after: number) => {
          asked.push(after);
          return { events: [] };
        },
        session: async () => ({ cursor: 9, session, turns: [turn], items: [closed], requests: [], tasks: [] }),
      },
      session.id,
    );
    expect(asked).toEqual([9]);
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

  test("the window rides through hydrate and the tail's companion snapshot", async () => {
    const windows: (SnapshotWindow | undefined)[] = [];
    const api = {
      events: async () => ({ events: [] as EngineEvent[] }),
      session: async (_sessionId: string, window?: SnapshotWindow) => {
        windows.push(window);
        return { cursor: 1, session, turns: [], items, requests: [], tasks: [] };
      },
    };
    await hydrateSession(api, session.id, { turns: INITIAL_TURNS });
    expect(windows).toEqual([{ turns: INITIAL_TURNS }]);

    windows.length = 0;
    await tailSession({ ...api, events: async () => ({ events: [started] }) }, session.id, 1, { turns: INITIAL_TURNS });
    expect(windows).toEqual([{ turns: INITIAL_TURNS }]);
  });

  test("loadOlderTurns asks for one page above the cursor", async () => {
    const windows: (SnapshotWindow | undefined)[] = [];
    const older = await loadOlderTurns(
      {
        events: async () => ({ events: [] }),
        session: async (_sessionId: string, window?: SnapshotWindow) => {
          windows.push(window);
          return {
            cursor: 9,
            session,
            turns: [turn],
            items,
            requests: [],
            tasks: [],
            page: { before: null, more: false },
          };
        },
      },
      session.id,
      "run_5",
    );
    expect(windows).toEqual([{ turns: OLDER_PAGE_TURNS, before: "run_5" }]);
    expect(older).toEqual({ turns: [turn], items: [], tasks: [], page: { before: null, more: false } });
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

describe("mergeOlderPage", () => {
  const makeTurn = (runId: string, sequence: number): Turn => ({ ...turn, runId, sequence });
  const makeItem = (id: string, runId: string): Item => ({
    id,
    runId,
    sessionId: "session_1",
    status: "completed",
    startedAt: 1,
    detail: { type: "assistant_message", text: id },
  });
  const makeTask = (id: string): Task => ({
    id,
    sessionId: "session_1",
    runId: "run_1",
    kind: "agent",
    state: "running",
    startedAt: 1,
    updatedAt: 1,
  });

  test("prepends the older page: oldest-first after merge, items and tasks included", () => {
    const current = {
      turns: [makeTurn("run_3", 3), makeTurn("run_4", 4)],
      items: [makeItem("i_3", "run_3")],
      tasks: [makeTask("t_new")],
    };
    const page = {
      turns: [makeTurn("run_1", 1), makeTurn("run_2", 2)],
      items: [makeItem("i_1", "run_1")],
      tasks: [makeTask("t_old")],
    };
    const merged = mergeOlderPage(current, page);
    expect(merged.turns.map((t) => t.runId)).toEqual(["run_1", "run_2", "run_3", "run_4"]);
    expect(merged.items.map((i) => i.id)).toEqual(["i_1", "i_3"]);
    expect(merged.tasks.map((t) => t.id)).toEqual(["t_old", "t_new"]);
  });

  test("an overlapping page is not duplicated — the already-loaded row wins", () => {
    const freshRun2 = { ...makeTurn("run_2", 2), state: "completed" as const };
    const current = { turns: [freshRun2, makeTurn("run_3", 3)], items: [makeItem("i_2", "run_2")], tasks: [] };
    const page = {
      turns: [makeTurn("run_1", 1), makeTurn("run_2", 2)],
      items: [makeItem("i_1", "run_1"), makeItem("i_2", "run_2")],
      tasks: [],
    };
    const merged = mergeOlderPage(current, page);
    expect(merged.turns.map((t) => t.runId)).toEqual(["run_1", "run_2", "run_3"]);
    // The row that stays is CURRENT's — the fresher read of a settling turn.
    expect(merged.turns[1]).toBe(freshRun2);
    expect(merged.items.map((i) => i.id)).toEqual(["i_1", "i_2"]);
  });

  test("is pure — neither input is mutated", () => {
    const current = { turns: [makeTurn("run_2", 2)], items: [], tasks: [] };
    const page = { turns: [makeTurn("run_1", 1)], items: [], tasks: [] };
    mergeOlderPage(current, page);
    expect(current.turns.map((t) => t.runId)).toEqual(["run_2"]);
    expect(page.turns.map((t) => t.runId)).toEqual(["run_1"]);
  });
});

/**
 * THE ONE-READ OPENING, AND THE QUIET TICK (#407) — the two halves of what made
 * switching conversations cost more than it had to.
 */
describe("opening in one read", () => {
  test("asks once where the engine offers it, and still meets the journal exactly", async () => {
    const calls: string[] = [];
    const api = {
      events: async (_sessionId: string, after: number) => {
        calls.push(`events:${after}`);
        return { events: [] };
      },
      session: async () => {
        calls.push("session");
        return { cursor: 1, session, turns: [turn], items, requests: [], tasks: [] };
      },
      sessionBootstrap: async (_sessionId: string, window?: SnapshotWindow) => {
        calls.push(`bootstrap:${window?.turns ?? "all"}`);
        return {
          cursor: 1,
          session,
          turns: [{ ...turn, state: "running" as const }],
          items,
          requests: [],
          tasks: [],
          events: [started],
          subscriptions: [],
        };
      },
    };

    const result = await hydrateSession(api, session.id, { turns: INITIAL_TURNS });
    // ONE call, and neither of the two it replaces.
    expect(calls).toEqual([`bootstrap:${INITIAL_TURNS}`]);
    expect(result.events).toEqual([started]);
    // The cursor a tail resumes from is the higher of the snapshot's stamp and
    // the journal it came with — the same arithmetic as the two-call path.
    expect(result.cursor).toBe(2);
    expect(result.turns[0]?.state).toBe("running");
    expect(result.subscriptions).toEqual([]);
  });

  test("an engine without the route is not a failed switch", async () => {
    // A remote Mac may be older than this route. The two-call path is the
    // fallback, not an error — a 404 per switch would be worse than the wait.
    const calls: string[] = [];
    const api = {
      events: async (_sessionId: string, after: number) => {
        calls.push(`events:${after}`);
        return { events: after === 0 ? [accepted] : [started] };
      },
      session: async () => {
        calls.push("session");
        return { cursor: 1, session, turns: [turn], items, requests: [], tasks: [] };
      },
    };
    const result = await hydrateSession(api, session.id);
    expect(calls).toEqual(["session", "events:1"]);
    expect(result.events).toEqual([started]);
  });
});

describe("mergeRows", () => {
  const a: Turn = { ...turn, runId: "run_a" };
  const b: Turn = { ...turn, runId: "run_b" };
  const id = (row: Turn) => row.runId;

  test("a merge that changed nothing hands back the array it was given", () => {
    /**
     * The quiet second of a tail: the same row objects arrive again because no
     * companion snapshot was fetched. A fresh array of identical rows is still
     * a new value to `useState`, and that is a whole cockpit re-render and a
     * whole transcript re-fold for a conversation that did not move.
     */
    const held = [a, b];
    expect(mergeRows(held, [a, b], id)).toBe(held);
    // …including when the fresh read carries only some of what is held.
    expect(mergeRows(held, [b], id)).toBe(held);
  });

  test("a row that actually moved still produces a new array", () => {
    const held = [a, b];
    const moved = { ...b, state: "running" as const };
    const merged = mergeRows(held, [moved], id);
    expect(merged).not.toBe(held);
    expect(merged).toEqual([a, moved]);
  });

  test("a new row is appended, and is a change", () => {
    const held = [a];
    const merged = mergeRows(held, [b], id);
    expect(merged).not.toBe(held);
    expect(merged).toEqual([a, b]);
  });
});
