// THE CRASH TRUTH-TELLER'S CONTRACT (creative-run defect, task #21): a
// session whose feed window never closed and whose runtime is gone gets ONE
// attention marker in its transcript, a spawn sweep, and a terminal `closed`
// on both log surfaces — and a second pass finds a closed window and does
// nothing. A live or gracefully-closed session is never touched.

// @ts-expect-error no @types/bun in this workspace
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Throwaway home BEFORE the imports resolve their module state (store.test.ts
// idiom) — nothing here may touch the real ~/.telar.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-repair-"));
process.env.TELAR_HOME = TMP;
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { repairInterruptedSession } = await import("./session-repair");
const log = await import("../session-log");
const store = await import("../store");

let n = 0;
const makeChat = (parts: Array<Record<string, unknown>>) => {
  const id = `repair-${++n}`;
  store.appendTurn({
    id,
    model: "sonnet",
    account: "personal",
    userMessage: { id: `${id}-u`, role: "user", parts: [{ type: "text", text: "q", done: true }] },
    assistantMessage: {
      id: `${id}-a`,
      role: "assistant",
      parts: parts as never,
    },
  } as never);
  return id;
};

const lastParts = (id: string) => {
  const chat = store.getChat(id) as { messages: Array<{ role: string; parts: unknown[] }> };
  return chat.messages[chat.messages.length - 1]?.parts as Array<{
    type: string;
    text?: string;
    attention?: boolean;
    taskStatus?: string;
  }>;
};

describe("repairInterruptedSession", () => {
  test("an unterminated window gets the marker, the sweep, and a closed — once", () => {
    const id = makeChat([
      { type: "text", text: "partial answer", done: true },
      // A launch-acked spawn the crash orphaned: no taskStatus ever landed.
      { type: "tool", name: "Task", id: "t1", agent: { name: "explore" } },
    ]);
    log.startSessionFeedWindow(id, "run-1", "q");
    log.appendFeedEvent(id, "text", { text: "partial answer" });
    // No `closed` — the server died here.

    expect(repairInterruptedSession(id)).toBe(true);

    const parts = lastParts(id);
    const tail = parts[parts.length - 1];
    expect(tail).toEqual({
      type: "marker",
      text: "interrupted — the server restarted",
      attention: true,
    });
    // The orphaned spawn no longer claims to be running.
    expect(parts.find((p) => p.type === "tool")?.taskStatus).toBe("stopped");
    // The window is now durably terminal…
    const { events } = log.readFeedEvents(id, null);
    expect(events[events.length - 1]?.event).toBe("closed");
    // …which is exactly why the second pass is a no-op.
    expect(repairInterruptedSession(id)).toBe(false);
    expect(lastParts(id).filter((p) => p.type === "marker")).toHaveLength(1);
  });

  test("a gracefully closed window is never touched", () => {
    const id = makeChat([{ type: "text", text: "done", done: true }]);
    log.startSessionFeedWindow(id, "run-1", "q");
    log.appendFeedEvent(id, "closed", {});
    expect(repairInterruptedSession(id)).toBe(false);
    expect(lastParts(id).some((p) => p.type === "marker")).toBe(false);
  });

  test("a session with no feed at all (pre-feed history, or never ran) is untouched", () => {
    const id = makeChat([{ type: "text", text: "old", done: true }]);
    expect(repairInterruptedSession(id)).toBe(false);
    expect(lastParts(id).some((p) => p.type === "marker")).toBe(false);
  });

  test("markLastTurnInterrupted alone is idempotent by trailing-marker equality", () => {
    const id = makeChat([{ type: "text", text: "x", done: true }]);
    expect(store.markLastTurnInterrupted(id, "interrupted — the server restarted")).toBe(true);
    expect(store.markLastTurnInterrupted(id, "interrupted — the server restarted")).toBe(false);
    expect(store.markLastTurnInterrupted("no-such-chat", "y")).toBe(false);
  });
});
