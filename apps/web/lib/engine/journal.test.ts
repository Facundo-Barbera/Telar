// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Turn } from "@telar/engine-client";
import {
  appendJournalEvents,
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
