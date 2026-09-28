// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Turn } from "@telar/engine-client";
import { envelope, item, turn } from "@/test/journal-fixtures";
import { appendJournalEvents, journalCursor, projectJournal, taskRoster } from "./journal";
import { isActiveTurn, itemLabel, itemText } from "./journal-items";
import { createJournalProjector } from "./journal-projector";

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
    // The next snapshot repairs the gap; inventing a row would have no kind.
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 1, type: "content.delta", itemId: "ghost", stream: "assistant_text", text: "x" },
    ]);
    expect(projected!.items).toEqual([]);
  });

  test("streamed text wins over stored detail while a turn is live", () => {
    // The engine folds text into its projection only when an item closes.
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", detail: { type: "assistant_message", text: "stale" } })],
      [{ ...envelope, id: 1, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "live" }],
    );
    expect(itemText(projected!.items[0]!)).toBe("live");
  });

  /**
   * A remount hydrates from a snapshot whose cursor is past every delta so far;
   * the snapshot's text is a prefix and later deltas append to it.
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

    const [uninterrupted] = projectJournal([turn], [], [opened, first, second]);

    const [remounted] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "Once upon ", streamedThrough: 2, detail: { type: "assistant_message", text: "" } })],
      [second],
    );

    expect(itemText(remounted!.items[0]!)).toBe(itemText(uninterrupted!.items[0]!));
    expect(itemText(remounted!.items[0]!)).toBe("Once upon a time");
  });

  test("a delta already inside the seeded prefix is not applied twice", () => {
    // The tail can re-deliver a delta the prefix already contains; the watermark makes that harmless.
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
     * Whichever prefix reaches further wins: repeated companion snapshots must not
     * rewind, and a reconnect's longer one must be adopted.
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
    const [projected] = projectJournal(
      [turn],
      [item({ id: "i1", streamed: "", streamedThrough: 1, detail: { type: "assistant_message", text: "" } })],
      [{ ...envelope, id: 4, type: "item.updated", item: item({ id: "i1", streamed: "Hello", streamedThrough: 3, detail: { type: "assistant_message", text: "" } }) }],
    );
    expect(itemText(projected!.items[0]!)).toBe("Hello");
  });

  test("two items streaming at once keep their own prefixes", () => {
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
    // Stop can leave an item `inProgress` forever; the prefix must survive the turn ending.
    const [projected] = projectJournal(
      [{ ...turn, state: "stopped" }],
      [item({ id: "i1", streamed: "half a th", streamedThrough: 2, detail: { type: "assistant_message", text: "" } })],
      [],
    );
    expect(itemText(projected!.items[0]!)).toBe("half a th");
  });

  test("a closed item's stored text replaces the seed, however long the seed was", () => {
    // Once closed, the stored detail wins even when shorter.
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
    expect(projected!.items.map((row) => row.id)).toEqual(["parent"]);
    expect(projected!.tasks).toHaveLength(1);
    expect(projected!.tasks[0]!.items.map((row: { id: string }) => row.id)).toEqual(["child"]);
    expect(projected!.tasks[0]).toMatchObject({ state: "completed", resultText: "found it" });
  });

  test("a snapshot's tasks are folded BEFORE its items, so nesting survives a reload", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "child", taskId: "task_a", detail: { type: "assistant_message", text: "from the child" } })],
      [],
      [task],
    );
    // Cold open: folding items before tasks would strand the row on the main timeline.
    expect(projected!.items).toEqual([]);
    expect(projected!.tasks[0]!.items.map((row: { id: string }) => row.id)).toEqual(["child"]);
  });

  test("the roster carries the live copy, so the panel is not reading a stale snapshot", () => {
    // The panel must see `task.*` events as they arrive, not only when a snapshot changes.
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
    // Background tasks outlive their turn; dropping unfiled ones loses exactly those.
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

  /** A wake-up turn is live from the provider's `requesting`, before any items arrive. */
  test("a wake-up with nothing on it yet is still a live turn (#71)", () => {
    const woken: Turn = {
      runId: "run_wake",
      sessionId: "s1",
      sequence: 2,
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
    expect(projected!.startedAt).toBe(10);
    expect(projected!.lastActivityAt).toBe(10);
    expect(projected!.origin).toBe("provider");
    expect(projected!.wokenBy).toBe("task_bg");
  });

  test("a turn opened so LIVE background work could be decided is not drawn as a wake-up (#891)", () => {
    /** A turn opened to decide a kept-alive task's tool call was not a wake-up. */
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
    expect(projectJournal([turn], [], [])[0]?.kind).toBeUndefined();
  });
});

describe("browser control rows", () => {
  test("human interaction that INTERRUPTED the agent renders as a labeled row inside the turn; the agent resuming and between-turn changes stay off the transcript", () => {
    const [projected] = projectJournal([turn], [], [
      { ...envelope, id: 5, type: "browser.control.changed", controller: "human", interrupted: true },
      { ...envelope, id: 6, type: "browser.control.changed", controller: "agent" },
      { ...envelope, id: 8, type: "browser.control.changed", controller: "idle" },
      // No runId: a change between turns is live state, not transcript history.
      { at: 2, sessionId: "s1", id: 7, type: "browser.control.changed", controller: "human" },
    ]);
    expect(projected!.items.map((row) => (row.detail.type === "unknown" ? row.detail.label : ""))).toEqual(["You interacted with the browser"]);
    expect(projected!.items.every((row) => row.status === "completed")).toBe(true);
    expect(projected!.items.map(itemLabel)).toEqual(["You interacted with the browser"]);
    expect(projected!.items.map(itemLabel).join(" ")).not.toMatch(/handed back|took the browser/);
  });

  test("touching the browser without interrupting the agent draws nothing", () => {
    /** The row explains a deferred or refused agent action; with nothing interrupted it is noise. */
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

/** A limit needs its code and reset time, via both the snapshot and the live tail. */
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

/** Must match the plain fold, and hand back the same object for turns whose rows didn't move. */
describe("turn order", () => {
  const a: Turn = { ...turn, runId: "run_a", sequence: 1, origin: "session", state: "running", acceptedAt: 50, updatedAt: 250, startedAt: 200 };
  const b: Turn = { ...turn, runId: "run_b", sequence: 2, origin: "provider", state: "completed", acceptedAt: 90, updatedAt: 150, startedAt: 100, completedAt: 150 };
  const queued: Turn = { ...turn, runId: "run_q", sequence: 0, state: "queued", acceptedAt: 10, updatedAt: 10 };
  const rows = [
    item({ id: "b_answer", runId: "run_b", status: "completed", startedAt: 120, completedAt: 150, detail: { type: "assistant_message", text: "done" } }),
    item({ id: "a_steer", runId: "run_a", status: "completed", startedAt: 250, completedAt: 250, detail: { type: "user_message", text: "and this?" } }),
  ];
  const order = (turns: { runId: string }[]) => turns.map((each) => each.runId);

  test("a lower-sequence turn that started later renders after the one that ran first", () => {
    const projected = projectJournal([a, b, queued], rows, []);
    expect(order(projected)).toEqual(["run_b", "run_a", "run_q"]);
    const shown = projected.flatMap((each) => each.items.map((row) => row.id));
    expect(shown.indexOf("a_steer")).toBeGreaterThan(shown.indexOf("b_answer"));
  });

  test("the incremental projector agrees, on the whole fold and on a single-run refold", () => {
    const project = createJournalProjector();
    expect(order(project([a, b, queued], rows, []))).toEqual(["run_b", "run_a", "run_q"]);
    const events = [{ ...envelope, id: 1, at: 260, runId: "run_a", type: "content.delta", itemId: "a_steer", stream: "assistant_text", text: "" }] as EngineEvent[];
    expect(order(project([a, b, queued], rows, events))).toEqual(["run_b", "run_a", "run_q"]);
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
