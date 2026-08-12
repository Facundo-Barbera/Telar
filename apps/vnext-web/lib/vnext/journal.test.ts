// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Turn } from "@telar/engine-client";
import {
  appendJournalEvents,
  isActiveTurn,
  isToolItem,
  itemLabel,
  itemText,
  journalCursor,
  projectJournal,
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
