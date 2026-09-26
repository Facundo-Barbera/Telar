// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import {
  appendJournalEvents,
  createJournalProjector,
  hostPassiveArrivals,
  isActiveTurn,
  isCompacting,
  isToolItem,
  itemLabel,
  itemText,
  journalCursor,
  projectJournal,
  taskRoster,
  toolOutput,
} from "./journal";

const turn: Turn = {
  runId: "run_1",
  sessionId: "s1",
  sequence: 1,
  input: "Please help",
  state: "running",
  acceptedAt: 1,
  updatedAt: 1,
};

const item = (over: Partial<Item> & Pick<Item, "id" | "detail">): Item => ({
  runId: "run_1",
  sessionId: "s1",
  status: "inProgress",
  startedAt: 1,
  ...over,
});

const envelope = { at: 1, sessionId: "s1", runId: "run_1" } as const;

describe("cursor merge", () => {
  test("tails without duplicating a record already held", () => {
    const first: EngineEvent[] = [
      { ...envelope, id: 1, type: "item.started", item: item({ id: "i1", detail: { type: "assistant_message", text: "" } }) },
    ];
    const merged = appendJournalEvents(first, [
      ...first,
      { ...envelope, id: 2, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Hi" },
    ]);
    expect(merged).toHaveLength(2);
    expect(journalCursor(merged)).toBe(2);
  });
});

describe("streaming text", () => {
  test("deltas accumulate onto the item that opened them", () => {
    const [projected] = projectJournal(
      [turn],
      [],
      [
        { ...envelope, id: 1, type: "item.started", item: item({ id: "i1", detail: { type: "assistant_message", text: "" } }) },
        { ...envelope, id: 2, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Hel" },
        { ...envelope, id: 3, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "lo" },
      ],
    );
    expect(itemText(projected!.items[0]!)).toBe("Hello");
  });

  test("a delta for an unknown item is dropped, not buffered into a placeholder", () => {
    // Inventing a row here would render a message with no idea what KIND of row
    // it belongs to. The next snapshot repairs the gap.
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 1, type: "content.delta", itemId: "ghost", stream: "assistant_text", text: "x" },
    ]);
    expect(projected!.items).toEqual([]);
  });

  test("streamed text wins over stored detail while a turn is live", () => {
    // The engine only folds accumulated text into its projection when an item
    // closes, so mid-flight the stored detail is deliberately stale.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", detail: { type: "assistant_message", text: "stale" } })],
      [{ ...envelope, id: 1, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "live" }],
    );
    expect(itemText(projected!.items[0]!)).toBe("live");
  });

  /**
   * #214: LEAVING THE SURFACE MID-REPLY AND COMING BACK MUST NOT LOSE THE
   * PREFIX, and it did.
   *
   * A remount throws the event tail away and re-opens on a snapshot. The
   * snapshot's cursor is the last event the ENGINE had written — deltas
   * included — but the engine does not fold streamed text into an item until it
   * closes, so a live item's stored detail is empty while its cursor is already
   * stamped past every delta so far. Hydrating from that cursor skips them, and
   * the reader sees only what arrived after they came back.
   *
   * THE SNAPSHOT'S TEXT IS A PREFIX AND DELTAS APPEND TO IT. That is the whole
   * contract, and it is what both halves of the fix have to honour: the engine
   * folds an open item's accumulated text at the same high-watermark as the
   * cursor, and the client seeds `streamedText` from it so the next delta
   * CONTINUES rather than REPLACES. Asserted against the uninterrupted fold, so
   * the test says "the same as never having left" rather than restating a
   * string.
   */
  test("a remount mid-reply keeps the prefix already streamed", () => {
    const opened: EngineEvent = {
      ...envelope,
      id: 1,
      type: "item.started",
      item: item({ id: "i1", detail: { type: "assistant_message", text: "" } }),
    };
    const first: EngineEvent = { ...envelope, id: 2, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " };
    const second: EngineEvent = { ...envelope, id: 3, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" };

    // Never left: one continuous fold over every event.
    const [uninterrupted] = projectJournal([turn], [], [opened, first, second]);

    // Left after `first` and came back. The snapshot reflects events up to id 2
    // — so it carries the item and the text streamed into it so far — and the
    // client tails from 2, which means `second` is the only event it ever sees.
    const [remounted] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "Once upon ", streamedThrough: 2, detail: { type: "assistant_message", text: "" } })],
      [second],
    );

    expect(itemText(remounted!.items[0]!)).toBe(itemText(uninterrupted!.items[0]!));
    expect(itemText(remounted!.items[0]!)).toBe("Once upon a time");
  });

  test("a delta already inside the seeded prefix is not applied twice", () => {
    // The snapshot and the tail are separate reads, so the tail legitimately
    // re-delivers a delta the prefix already contains. The watermark is what
    // makes that harmless — without it the two are indistinguishable.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "Once upon ", streamedThrough: 2, detail: { type: "assistant_message", text: "" } })],
      [
        { ...envelope, id: 2, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
        { ...envelope, id: 3, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
      ],
    );
    expect(itemText(projected!.items[0]!)).toBe("Once upon a time");
  });

  test("a reconnect's longer prefix is adopted; a repeat of the same one is not", () => {
    /**
     * REACH, NOT RECENCY. A companion snapshot rides every queue-changing
     * event, so the SAME prefix arrives again and again — adopting it
     * unconditionally would rewind a fold that has appended past it. A
     * reconnect brings a genuinely longer one, and refusing that would lose
     * every delta between the two watermarks. Whichever reaches further wins,
     * which is safe because the engine never un-streams text.
     */
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "Once upon a time, ", streamedThrough: 4, detail: { type: "assistant_message", text: "" } })],
      [
        // Stale repeat of the first snapshot's shorter prefix: must not rewind.
        { ...envelope, id: 5, type: "item.updated", item: item({ id: "i1", streamed: "Once upon ", streamedThrough: 2, detail: { type: "assistant_message", text: "" } }) },
        // Deltas below the adopted watermark stay inside it.
        { ...envelope, id: 3, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
        { ...envelope, id: 6, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "there was" },
      ],
    );
    expect(itemText(projected!.items[0]!)).toBe("Once upon a time, there was");
  });

  test("an item that has streamed nothing yet takes its first seed later", () => {
    // The first snapshot can land before a single delta — `streamed` empty,
    // watermark real. The next snapshot's prefix must still be adopted.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "", streamedThrough: 1, detail: { type: "assistant_message", text: "" } })],
      [{ ...envelope, id: 4, type: "item.updated", item: item({ id: "i1", streamed: "Hello", streamedThrough: 3, detail: { type: "assistant_message", text: "" } }) }],
    );
    expect(itemText(projected!.items[0]!)).toBe("Hello");
  });

  test("two items streaming at once keep their own prefixes", () => {
    // Interleaved A/B: B opens and completes while A is still streaming, and A
    // must not inherit B's text or lose its own to B's snapshot row.
    const [projected] = projectJournal(
      [turn],
      [
        item({ id: "a", streamed: "part one ", streamedThrough: 2, detail: { type: "assistant_message", text: "" } }),
        item({ id: "b", status: "completed", detail: { type: "reasoning", text: "closed thought" } }),
      ],
      [{ ...envelope, id: 3, type: "content.delta", itemId: "a", stream: "assistant_text", text: "part two" }],
    );
    const byId = new Map(projected!.items.map((row) => [row.id, row]));
    expect(itemText(byId.get("a")!)).toBe("part one part two");
    expect(itemText(byId.get("b")!)).toBe("closed thought");
  });

  test("a stopped turn keeps the partial text of an item it never closed", () => {
    // Unified Stop can leave an item `inProgress` forever. The prefix is the
    // only record of what the reader saw, so it must survive the turn going
    // terminal — and it is rebuildable from the journal, not only from RAM.
    const [projected] = projectJournal(
      [{ ...turn, state: "stopped" }],
      [item({ id: "i1", streamed: "half a th", streamedThrough: 2, detail: { type: "assistant_message", text: "" } })],
      [],
    );
    expect(itemText(projected!.items[0]!)).toBe("half a th");
  });

  test("a closed item's stored text replaces the seed, however long the seed was", () => {
    // Not "whichever is longer": a provider that rewrites its answer on close
    // must be able to SHORTEN it. Once the item is closed the stored detail is
    // the truth, and the streamed prefix stops being consulted.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", status: "completed", streamed: "a long partial draft", detail: { type: "assistant_message", text: "Short." } })],
      [],
    );
    expect(itemText(projected!.items[0]!)).toBe("Short.");
  });
});

describe("ordering", () => {
  test("items sort by the event id that opened them, not by timestamp", () => {
    // Two events can share a millisecond; the id is monotonic by construction.
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 5, at: 100, type: "item.started", item: item({ id: "late", startedAt: 100, detail: { type: "assistant_message", text: "" } }) },
      { ...envelope, id: 2, at: 100, type: "item.started", item: item({ id: "early", startedAt: 100, detail: { type: "reasoning", text: "" } }) },
    ]);
    expect(projected!.items.map((row) => row.id)).toEqual(["early", "late"]);
  });

  test("snapshot items sort before anything the tail opens", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "from-snapshot", detail: { type: "assistant_message", text: "a" } })],
      [{ ...envelope, id: 9, type: "item.started", item: item({ id: "from-tail", detail: { type: "reasoning", text: "" } }) }],
    );
    expect(projected!.items.map((row) => row.id)).toEqual(["from-snapshot", "from-tail"]);
  });
});

describe("sub-agents", () => {
  const task = {
    id: "task_a",
    sessionId: "s1",
    runId: "run_1",
    kind: "agent" as const,
    state: "running" as const,
    title: "Audit the parser",
    startedAt: 1,
    updatedAt: 1,
  };

  test("a sub-agent's rows nest under it instead of interleaving with the main loop's", () => {
    const [projected] = projectJournal(
      [turn],
      [],
      [
        { ...envelope, id: 1, type: "task.started", task },
        { ...envelope, id: 2, type: "item.started", item: item({ id: "child", taskId: "task_a", detail: { type: "command_execution", command: { command: "rg x" } } }) },
        { ...envelope, id: 3, type: "item.started", item: item({ id: "parent", detail: { type: "assistant_message", text: "hi" } }) },
        { ...envelope, id: 4, type: "task.completed", task: { ...task, state: "completed", resultText: "found it" } },
      ],
    );
    // Rendered flat, five concurrent agents read as one agent doing five
    // contradictory things. This split is what `Item.taskId` buys.
    expect(projected!.items.map((row) => row.id)).toEqual(["parent"]);
    expect(projected!.tasks).toHaveLength(1);
    expect(projected!.tasks[0]!.items.map((row: { id: string }) => row.id)).toEqual(["child"]);
    // The terminal event repeats the whole task; the rows it already collected
    // must survive that replacement.
    expect(projected!.tasks[0]).toMatchObject({ state: "completed", resultText: "found it" });
  });

  test("a snapshot's tasks are folded BEFORE its items, so nesting survives a reload", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "child", taskId: "task_a", detail: { type: "assistant_message", text: "from the child" } })],
      [],
      [task],
    );
    // The cold-open path: no events at all, only the two projections. Folding
    // items first would strand the row on the main timeline permanently.
    expect(projected!.items).toEqual([]);
    expect(projected!.tasks[0]!.items.map((row: { id: string }) => row.id)).toEqual(["child"]);
  });

  test("the roster carries the live copy, so the panel is not reading a stale snapshot", () => {
    // THE BUG THIS PINS: the transcript folds `task.*` events as they arrive
    // while the panel took the snapshot's `tasks` array, which only changes when
    // a tail response happens to carry a new snapshot. Two sub-agents ran in the
    // conversation while the Agents panel said "Sub-agents appear here as they
    // work" — a surface reading a list that had not been told yet.
    const [projected] = projectJournal(
      [turn],
      [],
      [{ ...envelope, id: 1, type: "task.completed", task: { ...task, state: "completed", resultText: "found it" } }],
      [task],
    );
    const roster = taskRoster([task], projected!.tasks);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ state: "completed", resultText: "found it" });
  });

  test("a task whose turn the journal never saw stays in the roster", () => {
    // Background work is DEFINED by outliving its turn, and `projectJournal`
    // files a task under the turn that launched it. Dropping what it cannot file
    // would lose exactly the tasks the panel most needs to keep showing.
    const orphan = { ...task, id: "task_b", runId: "run_gone" };
    const roster = taskRoster([task, orphan], [{ ...task, items: [] }]);
    expect(roster.map((entry) => entry.id)).toEqual(["task_a", "task_b"]);
    expect(roster[1]!.items).toEqual([]);
  });

  test("a row whose task is not known yet stays visible on the main timeline", () => {
    const [projected] = projectJournal(
      [turn],
      [],
      [{ ...envelope, id: 1, type: "item.started", item: item({ id: "orphan", taskId: "task_missing", detail: { type: "assistant_message", text: "x" } }) }],
    );
    // An invisible row is worse than a misplaced one.
    expect(projected!.items.map((row) => row.id)).toEqual(["orphan"]);
  });
});

describe("turn state", () => {
  test("every durable transition projects without waiting for a snapshot", () => {
    const [projected] = projectJournal([{ ...turn, state: "queued" }], [], [
      { ...envelope, id: 1, type: "turn.claimed", workerId: "worker_1" },
      { ...envelope, id: 2, type: "turn.started" },
      { ...envelope, id: 3, type: "turn.completed", resultText: "done" },
    ]);
    expect(projected!.state).toBe("completed");
    expect(projected!.resultText).toBe("done");
  });

  test("a failure message reaches the turn", () => {
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 1, type: "turn.failed", code: "driver_failed", message: "boom" },
    ]);
    expect(projected!.state).toBe("failed");
    expect(projected!.failure).toBe("boom");
  });

  test("recovery states are visible and not treated as active", () => {
    expect(isActiveTurn("running")).toBe(true);
    expect(isActiveTurn("ambiguous")).toBe(false);
    const [projected] = projectJournal([{ ...turn, state: "ambiguous" }], [], [
      { ...envelope, id: 1, type: "turn.discarded" },
    ]);
    expect(projected!.state).toBe("discarded");
  });

  test("usage rides the completion", () => {
    const usage = { tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.01 };
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 1, type: "turn.completed", resultText: "done", usage },
    ]);
    expect(projected!.usage?.costUsd).toBe(0.01);
  });

  /**
   * #71: A WAKE-UP IS VISIBLE FROM THE MOMENT THE REQUEST GOES OUT, not from
   * its first token.
   *
   * The cockpit draws its working indicator on ONE thing — the session's live
   * turn (`isActiveTurn`, and the executing turn is what `session-cockpit`
   * passes `live`) — so what the fold makes of the wake-up's opening triple IS
   * whether anything appears on screen. A background task ending, the model
   * generating, and a blank screen for the whole gap between them was read
   * twice as "the task didn't wake you up".
   *
   * The engine now opens the turn on the provider's own `requesting`
   * announcement (see the idle pump in apps/engine/src/driver.ts), so the
   * triple arrives with NO items behind it — which is exactly the state
   * asserted here: live, running, started, and nothing to show yet.
   */
  test("a wake-up with nothing on it yet is still a live turn (#71)", () => {
    const woken: Turn = {
      runId: "run_wake",
      sessionId: "s1",
      sequence: 2,
      // Opened before the CLI echoed its injected notification, so there is no
      // prompt to draw — the wake row names the task instead.
      input: "",
      origin: "provider",
      providerReason: { kind: "task_notification", taskId: "task_bg" },
      state: "running",
      acceptedAt: 10,
      startedAt: 10,
      updatedAt: 10,
    };
    const wake = { at: 10, sessionId: "s1", runId: "run_wake" } as const;
    const [projected] = projectJournal([], [], [
      { ...wake, id: 1, type: "turn.accepted", turn: woken, replayed: false },
      { ...wake, id: 2, type: "turn.claimed", workerId: "worker_1" },
      { ...wake, id: 3, type: "turn.started" },
    ]);
    expect(projected!.items).toEqual([]);
    expect(projected!.state).toBe("running");
    expect(isActiveTurn(projected!.state)).toBe(true);
    // The indicator's elapsed clock has a start, and its quiet clock a floor —
    // without these it would read 0s forever, or claim silence since the epoch.
    expect(projected!.startedAt).toBe(10);
    expect(projected!.lastActivityAt).toBe(10);
    // And it is drawn as a wake, not as a person's message.
    expect(projected!.origin).toBe("provider");
    expect(projected!.wokenBy).toBe("task_bg");
  });

  test("a turn opened so LIVE background work could be decided is not drawn as a wake-up (#891)", () => {
    /**
     * Same shape, opposite fact. The engine opens this turn because a task it
     * kept alive past turn end needs a tool call decided — nothing woke the
     * model and nothing was said. Projected as `wokenBy` it read as
     * "Sub-agent reported", a sentence about something that did not happen.
     */
    const claim: Turn = {
      runId: "run_claim",
      sessionId: "s1",
      sequence: 2,
      input: "",
      origin: "provider",
      providerReason: { kind: "background_task", taskId: "task_agent" },
      state: "running",
      acceptedAt: 10,
      startedAt: 10,
      updatedAt: 10,
    };
    const opened = { at: 10, sessionId: "s1", runId: "run_claim" } as const;
    const [projected] = projectJournal([], [], [
      { ...opened, id: 1, type: "turn.accepted", turn: claim, replayed: false },
      { ...opened, id: 2, type: "turn.claimed", workerId: "worker_1" },
      { ...opened, id: 3, type: "turn.started" },
    ]);
    expect(projected!.decidedForBackgroundWork).toBe(true);
    expect(projected!.askedBy).toBe("task_agent");
    expect(projected!.wokenBy).toBeUndefined();
    // And through the snapshot path, which is the one a client opening a cold
    // session reads.
    const [fromSnapshot] = projectJournal([claim], [], []);
    expect(fromSnapshot!.decidedForBackgroundWork).toBe(true);
    expect(fromSnapshot!.askedBy).toBe("task_agent");
    expect(fromSnapshot!.wokenBy).toBeUndefined();
  });

  test("an event for an unknown run does not invent a turn", () => {
    const projected = projectJournal([turn], [], [
      { ...envelope, id: 1, runId: "run_other", type: "turn.started" },
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.state).toBe("running");
  });
});

describe("item rendering helpers", () => {
  test("tool rows are classified as tools and prose is not", () => {
    const command = item({ id: "c", detail: { type: "command_execution", command: { command: "ls -la" } } });
    const message = item({ id: "m", detail: { type: "assistant_message", text: "hi" } });
    const [projected] = projectJournal([turn], [command, message], []);
    const [tool, prose] = projected!.items;
    expect(isToolItem(tool!)).toBe(true);
    expect(isToolItem(prose!)).toBe(false);
  });

  test("labels prefer the engine-stored title over a derived one", () => {
    // Three clients deriving "what does an edit of src/a.ts say collapsed"
    // independently is three answers, so the engine derives it once.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "c", title: "engine label", detail: { type: "command_execution", command: { command: "ls" } } })],
      [],
    );
    expect(itemLabel(projected!.items[0]!)).toBe("engine label");
  });

  test("a label is still derived when the engine stored none", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "f", detail: { type: "file_change", change: { path: "src/a.ts", kind: "edit" } } })],
      [],
    );
    expect(itemLabel(projected!.items[0]!)).toBe("src/a.ts");
  });

  test("command output is exposed for the collapsed body", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "c", status: "completed", detail: { type: "command_execution", command: { command: "ls", outputPreview: "a\nb" } } })],
      [],
    );
    expect(toolOutput(projected!.items[0]!)).toBe("a\nb");
  });
});

describe("isCompacting", () => {
  test("true exactly while a context_compaction row is open", () => {
    const during = projectJournal(
      [turn],
      [item({ id: "cc", detail: { type: "context_compaction" } })],
      [],
    )[0];
    expect(isCompacting(during)).toBe(true);
    const after = projectJournal(
      [turn],
      [item({ id: "cc", status: "completed", detail: { type: "context_compaction", preTokens: 9, postTokens: 3 } })],
      [],
    )[0];
    expect(isCompacting(after)).toBe(false);
    expect(isCompacting(undefined)).toBe(false);
  });
});

describe("the compaction gesture", () => {
  test("rides through the fold as a kind, from the snapshot and from the accepted event alike", () => {
    const compact: Turn = { ...turn, runId: "run_c", kind: "compact", input: "/compact" };
    const [fromSnapshot] = projectJournal([compact], [], []);
    expect(fromSnapshot?.kind).toBe("compact");
    const accepted = {
      id: 1,
      at: 1,
      sessionId: "session_one",
      runId: "run_c",
      type: "turn.accepted",
      turn: compact,
      replayed: false,
    } as EngineEvent;
    const [fromEvent] = projectJournal([], [], [accepted]);
    expect(fromEvent?.kind).toBe("compact");
    // An ordinary message carries no kind at all.
    expect(projectJournal([turn], [], [])[0]?.kind).toBeUndefined();
  });
});

describe("browser control rows", () => {
  test("human interaction that INTERRUPTED the agent renders as a labeled row inside the turn; the agent resuming and between-turn changes stay off the transcript", () => {
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 5, type: "browser.control.changed", controller: "human", interrupted: true },
      // The agent's side is routine in a shared browser — no "handed back" row.
      { ...envelope, id: 6, type: "browser.control.changed", controller: "agent" },
      { ...envelope, id: 8, type: "browser.control.changed", controller: "idle" },
      // No runId: a change between turns — live state for the panel mark,
      // not transcript history.
      { at: 2, sessionId: "s1", id: 7, type: "browser.control.changed", controller: "human" },
    ]);
    expect(projected!.items.map((row) => (row.detail.type === "unknown" ? row.detail.label : ""))).toEqual(["You interacted with the browser"]);
    expect(projected!.items.every((row) => row.status === "completed")).toBe(true);
    // The transcript renders through itemLabel — it must say the sentence,
    // not the wire type. This is what printed "unknown" on screen.
    expect(projected!.items.map(itemLabel)).toEqual(["You interacted with the browser"]);
    expect(projected!.items.map(itemLabel).join(" ")).not.toMatch(/handed back|took the browser/);
  });

  test("touching the browser without interrupting the agent draws nothing", () => {
    /**
     * THE NOISE THIS REMOVES: scrolling or clicking in a tab the agent is not
     * working in used to put "You interacted with the browser" in the
     * conversation, repeatedly, explaining nothing. The row exists to explain
     * a deferred or refused agent action; with nothing interrupted there is
     * nothing to explain.
     */
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 5, type: "browser.control.changed", controller: "human" },
      { ...envelope, id: 6, type: "browser.control.changed", controller: "idle" },
      { ...envelope, id: 7, type: "browser.control.changed", controller: "human" },
    ]);
    expect(projected!.items).toEqual([]);
  });

  test("a tab opened by the agent is a labeled row, and reads as one", () => {
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 5, type: "browser.state.changed", provider: "attached", tabs: [{ id: "0", url: "https://example.com/", title: "Example Domain", active: true }] },
      { ...envelope, id: 6, type: "browser.state.changed", provider: "attached", tabs: [
        { id: "0", url: "https://example.com/", title: "Example Domain", active: false },
        { id: "1", url: "https://news.ycombinator.com/", title: "Hacker News", active: true },
      ] },
    ]);
    expect(projected!.items.map(itemLabel)).toEqual(["Opened a tab — Hacker News"]);
  });
});

/**
 * #290 — A USAGE LIMIT IS NOT A FAULT, and the fold is where that survives.
 *
 * `failure` was projected as its message alone, so every failure reached the
 * transcript as one undifferentiated string. A limit needs the CODE and the
 * reset time to draw a row that says when it lifts, and both have to arrive by
 * two routes: the snapshot, and the event tail a client watches live.
 */
describe("a turn waiting out a usage limit", () => {
  const limited: Turn = {
    ...turn,
    state: "failed",
    failure: { code: "rate_limited", message: "Claude's five hour usage limit was reached, so this turn stopped where it stood.", resumeAt: 1_800_003_600_000, limitType: "five_hour" },
  };

  test("the snapshot carries the code, the reset time and which limit", () => {
    const [projected] = projectJournal([limited], [], []);
    expect(projected).toMatchObject({
      failureCode: "rate_limited",
      resumeAt: 1_800_003_600_000,
      limitType: "five_hour",
      failure: "Claude's five hour usage limit was reached, so this turn stopped where it stood.",
    });
  });

  test("the event tail carries them too, so a live client need not re-read the session", () => {
    const [tailed] = projectJournal([{ ...turn, state: "running" }], [], [
      {
        ...envelope,
        id: 2,
        type: "turn.failed",
        code: "rate_limited",
        message: "limited",
        resumeAt: 1_800_003_600_000,
        limitType: "five_hour",
      },
    ] as EngineEvent[]);
    expect(tailed).toMatchObject({ state: "failed", failureCode: "rate_limited", resumeAt: 1_800_003_600_000, limitType: "five_hour" });
  });

  test("a requeue after the reset says the engine did it, so the wait is not an unexplained gap", () => {
    const [resumed] = projectJournal([limited], [], [
      { ...envelope, id: 3, at: 1_800_003_600_100, type: "turn.requeued", reason: "rate_limit_reset" },
    ] as EngineEvent[]);
    expect(resumed).toMatchObject({ state: "queued", resumedAfterRateLimit: 1_800_003_600_100 });
  });

  test("an ordinary requeue claims nothing about limits", () => {
    const [requeued] = projectJournal([{ ...turn, state: "steering" }], [], [
      { ...envelope, id: 4, type: "turn.requeued", reason: "steer_undelivered" },
    ] as EngineEvent[]);
    expect(requeued?.state).toBe("queued");
    expect(requeued?.resumedAfterRateLimit).toBeUndefined();
  });

  test("an ordinary failure carries a code but no reset time to promise", () => {
    const [projected] = projectJournal([{ ...turn, state: "failed", failure: { code: "driver_failed", message: "the CLI died" } }], [], []);
    expect(projected?.failureCode).toBe("driver_failed");
    expect(projected?.resumeAt).toBeUndefined();
  });
});

/**
 * THE MEMOISED PROJECTION (#407).
 *
 * Two claims, and only the first is about correctness: the projector must
 * answer exactly what the fold answers, for every shape the fold handles. The
 * second is the whole point of it existing — a turn whose rows did not move is
 * not folded again, and the identity of the returned object is how that is
 * observable at all.
 */
describe("createJournalProjector", () => {
  const runTurn = (runId: string, over: Partial<Turn> = {}): Turn => ({ ...turn, runId, state: "completed", ...over });

  /** A journal with something of every kind in it, spread over two turns —
   *  including the browser diff, which is the one thing the fold carries ACROSS
   *  turns and therefore the one thing a per-turn projector could get wrong. */
  const busy = () => {
    const turns: Turn[] = [runTurn("run_1"), runTurn("run_2", { state: "running" })];
    const items: Item[] = [
      item({ id: "i1", runId: "run_1", status: "completed", detail: { type: "assistant_message", text: "the first answer" } }),
      item({ id: "i2", runId: "run_2", detail: { type: "assistant_message", text: "" } }),
    ];
    const tasks: Task[] = [
      { id: "t1", runId: "run_2", sessionId: "s1", state: "running", startedAt: 4, updatedAt: 4, kind: "agent", title: "reviewer" },
    ];
    const events: EngineEvent[] = [
      { ...envelope, id: 10, runId: "run_1", type: "browser.state.changed", provider: "attached", tabs: [{ id: "0", url: "https://example.com/", title: "Example", active: true }] },
      { ...envelope, id: 11, runId: "run_2", type: "task.started", task: tasks[0]! },
      // The DIFF for this one is against the tab set turn 1 established. A
      // projector folding run_2 alone cannot see event 10, so this row is the
      // proof that the carry is handed in rather than recomputed.
      { ...envelope, id: 12, runId: "run_2", type: "browser.state.changed", provider: "attached", tabs: [
        { id: "0", url: "https://example.com/", title: "Example", active: false },
        { id: "1", url: "https://news.ycombinator.com/", title: "Hacker News", active: true },
      ] },
      { ...envelope, id: 13, runId: "run_2", type: "content.delta", itemId: "i2", stream: "assistant_text", text: "streaming" },
    ];
    return { turns, items, events, tasks };
  };

  test("answers exactly what the whole-journal fold answers", () => {
    const { turns, items, events, tasks } = busy();
    expect(createJournalProjector()(turns, items, events, tasks)).toEqual(projectJournal(turns, items, events, tasks));
  });

  test("the cross-turn tab diff survives being folded a turn at a time", () => {
    const { turns, items, events, tasks } = busy();
    const [, second] = createJournalProjector()(turns, items, events, tasks);
    // "Opened a tab", not "Closed" and not nothing: the left-hand side of the
    // diff came from a turn this fold never looked at.
    expect(second!.items.map(itemLabel)).toContain("Opened a tab — Hacker News");
  });

  test("a turn nothing happened to is not folded again", () => {
    const { turns, items, events, tasks } = busy();
    const project = createJournalProjector();
    const [firstBefore, secondBefore] = project(turns, items, events, tasks);

    // The shape of a quiet tail: the same rows handed back, in a new array.
    const [firstAfter, secondAfter] = project([...turns], [...items], [...events], [...tasks]);
    expect(firstAfter).toBe(firstBefore);
    expect(secondAfter).toBe(secondBefore);
  });

  test("a turn that moved is refolded, and only that turn", () => {
    const { turns, items, events, tasks } = busy();
    const project = createJournalProjector();
    const [settledBefore, liveBefore] = project(turns, items, events, tasks);

    const streamed: EngineEvent[] = [
      ...events,
      { ...envelope, id: 14, runId: "run_2", type: "content.delta", itemId: "i2", stream: "assistant_text", text: " more" },
    ];
    const [settledAfter, liveAfter] = project(turns, items, streamed, tasks);
    expect(settledAfter).toBe(settledBefore);
    expect(liveAfter).not.toBe(liveBefore);
    expect(liveAfter!.items[0]?.streamedText).toBe("streaming more");
    expect(liveBefore!.items[0]?.streamedText).toBe("streaming");
  });

  test("a run introduced by turn.accepted lands in the fold's own order", () => {
    const { turns, items, events, tasks } = busy();
    const accepted: EngineEvent[] = [
      ...events,
      { ...envelope, id: 15, runId: "run_3", type: "turn.accepted", replayed: false, turn: runTurn("run_3", { state: "queued", input: "and another" }) },
    ];
    const projected = createJournalProjector()(turns, items, accepted, tasks);
    expect(projected.map((each) => each.runId)).toEqual(projectJournal(turns, items, accepted, tasks).map((each) => each.runId));
    expect(projected.map((each) => each.runId)).toEqual(["run_1", "run_2", "run_3"]);
  });

  test("a turn that left the window takes its cache entry with it", () => {
    const { turns, items, events, tasks } = busy();
    const project = createJournalProjector();
    const [first] = project(turns, items, events, tasks);

    // Switched conversation: nothing in common. Then back — and the entry must
    // have been dropped rather than answering for a journal it never saw.
    expect(project([runTurn("run_9")], [], [], [])).toHaveLength(1);
    const [again] = project(turns, items, events, tasks);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  test("an empty journal is empty, and asking twice stays empty", () => {
    const project = createJournalProjector();
    expect(project([], [], [], [])).toEqual([]);
    expect(project([], [], [], [])).toEqual([]);
  });
});

describe("passive arrivals", () => {
  /**
   * THE DELTA COORDINATOR, 17:58–18:06. Run 386 ran for 7m46s; peer turns 392,
   * 394 and 397 reached it BUSY, so each was accepted passive, got its row and
   * completed at once. Drawn as turns of their own they sat under the working
   * line while 386 ran, and after all of 386 once it stopped.
   */
  const notice = (runId: string, from: string) =>
    ({
      kind: "peer_message",
      sessionId: from,
      runId,
      intent: "result",
      summary: `[agent message · result] session ${from} sent this session a result`,
      fetch: { sessionId: "s1", runId },
      body: `[agent message · result] session ${from} sent this session a result`,
    }) as NonNullable<Turn["notification"]>;
  const passive = (runId: string, sequence: number, at: number, from: string): Turn => ({
    runId,
    sessionId: "s1",
    sequence,
    input: "the peer's words",
    origin: "session",
    sender: { sessionId: from },
    agentIntent: "result",
    agentDelivery: "passive",
    notification: notice(runId, from),
    state: "completed",
    resultText: "",
    acceptedAt: at,
    updatedAt: at,
    completedAt: at,
  });
  const arrival = (runId: string, at: number): Item =>
    item({ id: `notification_${runId}`, runId, status: "completed", startedAt: at, completedAt: at, detail: { type: "notification", notification: notice(runId, "peer") } });
  const said = (id: string, at: number): Item =>
    item({ id, runId: "run_386", status: "completed", startedAt: at, completedAt: at, detail: { type: "assistant_message", text: id } });
  const host: Turn = { ...turn, runId: "run_386", sequence: 386, input: "[wake]", state: "running", acceptedAt: 100, updatedAt: 100, startedAt: 100 };
  const guests = [passive("run_392", 392, 120, "…41bed0"), passive("run_394", 394, 130, "…84af05"), passive("run_397", 397, 160, "…abefd6")];
  const rows = [said("answer_early", 110), arrival("run_392", 120), arrival("run_394", 130), said("answer_final", 150), arrival("run_397", 160)];

  test("each lands inside the running turn, in time order, above the working line", () => {
    const projected = projectJournal([host, ...guests], rows, []);
    const shown = hostPassiveArrivals(projected);
    expect(shown.map((row) => row.runId)).toEqual(["run_386"]);
    expect(shown[0]!.items.map((row) => row.id)).toEqual(["answer_early", "notification_run_392", "notification_run_394", "answer_final", "notification_run_397"]);
    // The projector caches its folds; the host it handed over is untouched.
    expect(projected[0]!.items.map((row) => row.id)).toEqual(["answer_early", "answer_final"]);
  });

  test("and stay there once the turn is stopped and the next one begins", () => {
    const stopped: Turn = { ...host, state: "stopped", completedAt: 170 };
    const next: Turn = { ...turn, runId: "run_398", sequence: 398, input: "Hola?", state: "running", acceptedAt: 200, updatedAt: 200, startedAt: 200 };
    const shown = hostPassiveArrivals(projectJournal([stopped, ...guests, next], rows, []));
    expect(shown.map((row) => row.runId)).toEqual(["run_386", "run_398"]);
    expect(shown[0]!.items.filter((row) => row.detail.type === "notification")).toHaveLength(3);
    expect(shown[1]!.items).toEqual([]);
  });

  test("off the live tail too: the end the tail reports bounds the host", () => {
    const late = passive("run_399", 399, 180, "…f00");
    const events: EngineEvent[] = [
      { ...envelope, id: 1, at: 170, runId: "run_386", type: "turn.stopped" },
      { ...envelope, id: 2, at: 180, runId: "run_399", type: "turn.accepted", turn: { ...late, state: "queued" }, replayed: false },
      { ...envelope, id: 3, at: 180, runId: "run_399", type: "item.started", item: arrival("run_399", 180) },
      { ...envelope, id: 4, at: 180, runId: "run_399", type: "turn.completed", resultText: "" },
    ] as EngineEvent[];
    const shown = hostPassiveArrivals(projectJournal([host], [said("answer_early", 110)], events));
    // Arrived after the turn it would have joined had ended: a row of its own.
    expect(shown.map((row) => row.runId)).toEqual(["run_386", "run_399"]);
  });

  test("a passive arrival with no turn running stays a row", () => {
    const idle: Turn = { ...host, state: "completed", completedAt: 105 };
    expect(hostPassiveArrivals(projectJournal([idle, ...guests], rows, [])).map((row) => row.runId)).toEqual(["run_386", "run_392", "run_394", "run_397"]);
  });

  test("a wake — delivered, not passive — is still a turn of its own", () => {
    const woke: Turn = { ...guests[0]!, agentDelivery: "wake" };
    expect(hostPassiveArrivals(projectJournal([host, woke], rows, [])).map((row) => row.runId)).toEqual(["run_386", "run_392"]);
  });
});

describe("a turn the engine wrote after a planned restart", () => {
  const restartOrigin = { reason: "update" as const, plannedAt: 1_800_000_000_000, interruptedRunId: "run_0" };
  const continued: Turn = { ...turn, origin: "restart", restartOrigin, input: "Telar restarted to install an update in the middle of your last turn." };

  test("the snapshot and the event tail both carry what it continued, so it is not drawn as the person's words", () => {
    const [projected] = projectJournal([continued], [], []);
    expect(projected).toMatchObject({ origin: "restart", restartOrigin });
    const [tailed] = projectJournal([], [], [{ ...envelope, id: 1, type: "turn.accepted", turn: continued }] as EngineEvent[]);
    expect(tailed).toMatchObject({ origin: "restart", restartOrigin });
  });
});
