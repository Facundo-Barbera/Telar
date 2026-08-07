// THE FEED'S CURSOR CONTRACT, PINNED (server-layer contract §B): windows
// replace line counting, {win,seq} replaces "how many lines have I read", and
// a stale-window reader gets the current window replayed from its start —
// the same re-base semantics the delta ring's {gen,index} cursor established.
// The turn-end flip builds on exactly these properties; if one changes, the
// background tail double-renders or goes blind.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the log at a throwaway home BEFORE importing it (store.test.ts idiom)
// — nothing here may touch the real ~/.telar.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-feed-"));
process.env.TELAR_HOME = TMP;
beforeEach(() => {
  process.env.TELAR_HOME = TMP;
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const log = await import("./session-log");

let n = 0;
const sid = () => `feed-test-${++n}`;

const feedPath = (sessionId: string) => path.join(TMP, "sessions", sessionId, "feed.ndjson");

describe("session feed", () => {
  test("a window opens with a header and the user line, and win increments per window", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "first question");
    const one = log.readFeedEvents(id, null);
    expect(one.events.map((e) => [e.win, e.seq, e.event])).toEqual([
      [1, 0, "window"],
      [1, 1, "user"],
    ]);
    expect(one.events[1]?.data).toEqual({ text: "first question" });
    // A second window truncates the file and re-bases on win 2.
    log.startSessionFeedWindow(id, "run-2", "second question");
    const two = log.readFeedEvents(id, null);
    expect(two.events.map((e) => [e.win, e.seq, e.event])).toEqual([
      [2, 0, "window"],
      [2, 1, "user"],
    ]);
  });

  test("a hidden (machinery) window writes no user line, same rule as the live log", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "kickoff instruction", true);
    const { events } = log.readFeedEvents(id, null);
    expect(events.map((e) => e.event)).toEqual(["window"]);
    // The next append lands at seq 1 — the slot the user line didn't take.
    expect(log.appendFeedEvent(id, "text", { text: "hi" })).toEqual({ win: 1, seq: 1 });
  });

  test("appends allocate monotonic seqs and incremental reads pick up from a cursor", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "q");
    log.appendFeedEvent(id, "tool", { id: "t1", name: "Read" });
    const mid = log.readFeedEvents(id, null);
    expect(mid.next).toEqual({ win: 1, seq: 2 });
    log.appendFeedEvent(id, "tool_result", { id: "t1", output: "ok" });
    log.appendFeedEvent(id, "text", { text: "done" });
    const tail = log.readFeedEvents(id, mid.next);
    expect(tail.events.map((e) => [e.seq, e.event])).toEqual([
      [3, "tool_result"],
      [4, "text"],
    ]);
    expect(log.sessionFeedCursor(id)).toEqual({ win: 1, seq: 4 });
    // Nothing new → empty read, cursor unchanged.
    expect(log.readFeedEvents(id, tail.next).events).toEqual([]);
  });

  test("a stale-window cursor replays the current window from its start", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "q1");
    log.appendFeedEvent(id, "text", { text: "a1" });
    const old = log.readFeedEvents(id, null).next;
    log.startSessionFeedWindow(id, "run-2", "q2");
    log.appendFeedEvent(id, "text", { text: "a2" });
    const replay = log.readFeedEvents(id, old);
    expect(replay.events.map((e) => [e.win, e.seq, e.event])).toEqual([
      [2, 0, "window"],
      [2, 1, "user"],
      [2, 2, "text"],
    ]);
  });

  test("the allocator recovers from the file after a process reload", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "q");
    log.appendFeedEvent(id, "text", { text: "before reload" });
    // Simulate the dev-server reload: the globalThis map loses this session.
    const g = globalThis as unknown as { __telarSessionFeeds?: Map<string, unknown> };
    g.__telarSessionFeeds?.delete(id);
    const cursor = log.appendFeedEvent(id, "text", { text: "after reload" });
    expect(cursor).toEqual({ win: 1, seq: 3 });
    const { events } = log.readFeedEvents(id, null);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  test("a corrupt line is skipped without derailing the read", () => {
    const id = sid();
    log.startSessionFeedWindow(id, "run-1", "q");
    log.appendFeedEvent(id, "text", { text: "good" });
    fs.appendFileSync(feedPath(id), "{not json\n");
    log.appendFeedEvent(id, "text", { text: "also good" });
    const { events } = log.readFeedEvents(id, null);
    expect(events.map((e) => e.event)).toEqual(["window", "user", "text", "text"]);
  });

  test("feed writes never throw for an unwritable session dir", () => {
    // Missing directory (no window ever started) → append recovers win 0 and
    // still fails the write because the dir doesn't exist; that failure must
    // surface as null, never a throw into the turn.
    const cursor = log.appendFeedEvent("never-started/nested", "text", { text: "x" });
    expect(cursor).toBeNull();
  });

  test("a failed write leaves ONE trace per burst — never silence, never a firehose", () => {
    // The creative-run defect: every caller drops appendFeedEvent's null, so
    // a feed that can't write made background output vanish without a trace.
    // The reporter lives INSIDE the writer (one place, five call sites) and
    // throttles per session, because a failing disk fails for every event.
    const seen: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void seen.push(args);
    try {
      expect(log.appendFeedEvent("no-dir/burst", "text", { text: "x" })).toBeNull();
      expect(log.appendFeedEvent("no-dir/burst", "text", { text: "y" })).toBeNull();
      const mine = seen.filter((a) => String(a[0]).includes("[session-feed]"));
      expect(mine.length).toBe(1);
      expect(String(mine[0]?.[0])).toContain("not reaching subscribers");
    } finally {
      console.error = orig;
    }
  });
});
