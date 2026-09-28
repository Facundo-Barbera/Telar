// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@telar/engine-client";
import { appendJournalEvents, journalCursor } from "./journal-events";

const envelope = { at: 1, sessionId: "s1", runId: "run_1" } as const;
const opened = { runId: "run_1", sessionId: "s1", status: "inProgress", startedAt: 1, id: "i1", detail: { type: "assistant_message", text: "" } } as const;

describe("cursor merge", () => {
  test("tails without duplicating a record already held", () => {
    const first: EngineEvent[] = [
      { ...envelope, id: 1, type: "item.started", item: opened },
    ];
    const merged = appendJournalEvents(first, [
      ...first,
      { ...envelope, id: 2, type: "content.delta", itemId: "i1", stream: "assistant_text", text: "Hi" },
    ]);
    expect(merged).toHaveLength(2);
    expect(journalCursor(merged)).toBe(2);
  });
});
