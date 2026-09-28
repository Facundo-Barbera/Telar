// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { envelope, item, turn } from "@/test/journal-fixtures";
import { projectJournal } from "./journal";
import { itemLabel } from "./journal-items";
import { createJournalProjector } from "./journal-projector";

describe("createJournalProjector", () => {
  const runTurn = (runId: string, over: Partial<Turn> = {}): Turn => ({ ...turn, runId, state: "completed", ...over });

  /** Includes the browser diff, the one thing the fold carries across turns. */
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
      // Diffed against turn 1's tabs, so the carry must be handed in.
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
    expect(second!.items.map(itemLabel)).toContain("Opened a tab — Hacker News");
  });

  test("a turn nothing happened to is not folded again", () => {
    const { turns, items, events, tasks } = busy();
    const project = createJournalProjector();
    const [firstBefore, secondBefore] = project(turns, items, events, tasks);

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

    // Switching conversations must drop the cache entry.
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
