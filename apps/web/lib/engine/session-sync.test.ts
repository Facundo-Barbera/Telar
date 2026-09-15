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
import { itemText, projectJournal } from "./journal";

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

/**
 * THE JOURNAL ARRIVES IN PAGES NOW (#494), and a reader that folded the first
 * one and stopped would leave the transcript silently short of what the session
 * actually did. These price the two halves of that: a quiet tick still costs
 * ONE request, and a tick that comes back to a session which ran while the tab
 * slept keeps asking until the engine says there is no more.
 */
describe("paging the journal", () => {
  const event = (id: number): EngineEvent => ({ ...envelope, id, at: id, type: "turn.started" });

  test("a tick that gets a full page keeps paging, and asks from the last id it saw", async () => {
    const asked: number[] = [];
    const pages = [
      { events: [event(11), event(12)], more: true },
      { events: [event(13), event(14)], more: true },
      { events: [event(15)], more: false },
    ];
    const api = {
      events: async (_sessionId: string, after: number) => {
        asked.push(after);
        return pages.shift()!;
      },
      session: async () => ({ cursor: 0, session, turns: [], items: [], requests: [], tasks: [] }),
    };
    const tail = await tailSession(api, session.id, 10);
    // KEYSET, not offset: each ask names the last id folded, so a delta landing
    // mid-walk can neither be skipped nor counted twice.
    expect(asked).toEqual([10, 12, 14]);
    expect(tail.events.map((each) => each.id)).toEqual([11, 12, 13, 14, 15]);
    expect(tail.cursor).toBe(15);
  });

  test("the quiet second still costs exactly one request", async () => {
    let calls = 0;
    const api = {
      events: async () => {
        calls += 1;
        return { events: [], more: false };
      },
      session: async () => ({ cursor: 0, session, turns: [], items: [], requests: [], tasks: [] }),
    };
    const tail = await tailSession(api, session.id, 42);
    expect(calls).toBe(1);
    expect(tail.events).toEqual([]);
    // The cursor does not move backwards on an empty answer.
    expect(tail.cursor).toBe(42);
  });

  test("an engine that never sends `more` is read exactly as it always was", async () => {
    // A REMOTE host may predate the paged route. Absent must mean "that was
    // everything" — the meaning it had before the field existed.
    let calls = 0;
    const api = {
      events: async () => {
        calls += 1;
        return { events: [event(7)] };
      },
      session: async () => ({ cursor: 0, session, turns: [], items: [], requests: [], tasks: [] }),
    };
    expect((await tailSession(api, session.id, 6)).events.map((each) => each.id)).toEqual([7]);
    expect(calls).toBe(1);
  });

  test("a page that claims `more` but moves nothing ends the walk instead of spinning", async () => {
    // The one way this loop could fail to terminate: re-asking from a cursor
    // that never advances. A tick runs once a second — it may not hang.
    let calls = 0;
    const api = {
      events: async () => {
        calls += 1;
        return { events: [], more: true };
      },
      session: async () => ({ cursor: 0, session, turns: [], items: [], requests: [], tasks: [] }),
    };
    const tail = await tailSession(api, session.id, 5);
    expect(calls).toBe(1);
    expect(tail.cursor).toBe(5);
  });

  test("the cursorless fallback walks to the END of the journal, not to the end of page one", async () => {
    /**
     * An engine too old to stamp a snapshot cursor makes `hydrateSession` ask
     * the journal where it ends. A page answers from the BEGINNING, so reading
     * one and taking its last id would tail from event 2 and re-fold the whole
     * history — the exact cost paging exists to remove.
     */
    const asked: number[] = [];
    const pages = [
      { events: [event(1), event(2)], more: true },
      { events: [event(3)], more: false },
      { events: [], more: false },
    ];
    const api = {
      events: async (_sessionId: string, after: number) => {
        asked.push(after);
        return pages.shift()!;
      },
      session: async () => ({ session, turns: [], items: [], requests: [], tasks: [] }),
    };
    const hydrated = await hydrateSession(api, session.id);
    expect(asked).toEqual([0, 2, 3]);
    expect(hydrated.cursor).toBe(3);
    expect(hydrated.events).toEqual([]);
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

/**
 * #214 (1): LEAVING A CONVERSATION MID-REPLY AND COMING BACK.
 *
 * The two halves of the fix are tested apart — the engine folds an open item's
 * streamed text into the snapshot at the same watermark it stamps the cursor,
 * and the client's fold seeds `streamedText` from it (journal.test.ts). Neither
 * test exercises the JOIN, which is where a remount actually lives: the prefix
 * comes from one read and the deltas from another, and the only thing keeping
 * them from overlapping or from leaving a hole is that the cursor hydration
 * tails from is the watermark the prefix runs through.
 *
 * So this drives the real sequence — hydrate, fold — against a journal, with
 * the snapshot DERIVED from that journal exactly as the engine derives it. A
 * hand-typed prefix would agree with a hand-typed cursor whatever either of
 * them said; deriving both means an off-by-one in either direction shows up as
 * a duplicated or missing chunk.
 */
describe("a remount mid-stream", () => {
  const open: Item = {
    id: "i1",
    runId: "run_1",
    sessionId: "session_1",
    status: "inProgress",
    startedAt: 1,
    // Empty until it closes: the engine does not rewrite the whole document per
    // token, so mid-flight the stored detail is deliberately stale.
    detail: { type: "assistant_message", text: "" },
  };
  const journal: EngineEvent[] = [
    { ...envelope, id: 1, type: "turn.accepted", turn, replayed: false },
    { ...envelope, id: 2, type: "turn.started" },
    { ...envelope, id: 3, type: "item.started", item: open },
    { ...envelope, id: 4, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
    { ...envelope, id: 5, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time, " },
    { ...envelope, id: 6, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "there was" },
  ];
  const live: Turn = { ...turn, state: "running" };

  /** What the engine's `openItemPrefix` builds: the deltas written for an open
   *  item THROUGH a cursor, and the id of the last one that counted. */
  const snapshotAt = (cursor: number) => {
    const deltas = journal.filter((event) => event.id <= cursor && event.type === "content.delta" && event.itemId === "i1");
    const last = deltas.at(-1);
    return {
      cursor,
      session,
      turns: [live],
      items: [
        {
          ...open,
          ...(last
            ? { streamed: deltas.map((event) => (event.type === "content.delta" ? event.text : "")).join(""), streamedThrough: last.id }
            : {}),
        },
      ],
      requests: [],
      tasks: [],
    };
  };
  const tailFrom = (after: number) => ({ events: journal.filter((event) => event.id > after) });
  const textOf = (turns: ReturnType<typeof projectJournal>) => itemText(turns[0]!.items[0]!);

  // Never left: one fold over the whole journal, which is what the reader saw
  // before they switched away and what they must see when they come back.
  const uninterrupted = textOf(projectJournal([live], [], journal));

  test("the snapshot's prefix and the deltas since reproduce the reply exactly, in one read or two", async () => {
    expect(uninterrupted).toBe("Once upon a time, there was");

    for (const cursor of [3, 4, 5, 6]) {
      const snapshot = snapshotAt(cursor);
      const two = await hydrateSession(
        { events: async (_id: string, after: number) => tailFrom(after), session: async () => snapshot },
        session.id,
      );
      expect(textOf(projectJournal(two.turns, two.items, two.events))).toBe(uninterrupted);

      // …and through the one-read opening, which is the path a switch takes.
      const one = await hydrateSession(
        {
          events: async (_id: string, after: number) => tailFrom(after),
          session: async () => snapshot,
          sessionBootstrap: async () => ({ ...snapshot, ...tailFrom(snapshot.cursor), subscriptions: [] }),
        },
        session.id,
      );
      expect(textOf(projectJournal(one.turns, one.items, one.events))).toBe(uninterrupted);
    }
  });

  test("a tail that re-delivers what the prefix already holds does not double it", async () => {
    /**
     * THE OVERLAP IS EXPECTED, NOT A BUG: the snapshot and the journal are
     * separate reads, and the engine stamps the cursor BEFORE the snapshot so
     * the tail overlaps rather than gaps. Here the tail is asked from a point
     * BELOW the prefix's watermark — a conservative client, or an engine whose
     * stamp lagged — and the watermark is the only thing that tells a delta
     * already inside the prefix from a new one.
     */
    const snapshot = snapshotAt(5);
    const hydrated = await hydrateSession(
      { events: async () => tailFrom(2), session: async () => snapshot },
      session.id,
    );
    expect(textOf(projectJournal(hydrated.turns, hydrated.items, hydrated.events))).toBe(uninterrupted);
  });

  test("switching back twice during the same reply is the same answer each time", async () => {
    // Each return is its own hydrate against a further-along snapshot; none of
    // them may rewind, duplicate, or restart the text.
    const api = (cursor: number) => ({
      events: async (_id: string, after: number) => tailFrom(after),
      session: async () => snapshotAt(cursor),
    });
    const first = await hydrateSession(api(4), session.id);
    expect(textOf(projectJournal(first.turns, first.items, first.events))).toBe(uninterrupted);
    const second = await hydrateSession(api(6), session.id);
    expect(textOf(projectJournal(second.turns, second.items, second.events))).toBe(uninterrupted);
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
