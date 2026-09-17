/**
 * WHAT HAPPENED, DECIDED ONCE — issue #572.
 *
 * The table below is the whole point of the module: every kind crossed with
 * every intent, in one place, so a surface cannot answer differently. The bug
 * was a peer's `result` classified as a wake and titled "Session finished a
 * turn" beside the completion that actually was one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { inboxSubject, notificationHead, notificationVerbs, stripNotificationKind, NOTIFICATION_HEAD_CHARS } from "./notifications";

describe("what a happening is called", () => {
  test("a peer's message is named by what the sender said it was", () => {
    expect(notificationVerbs({ kind: "peer_message", intent: "task" })).toEqual({ verb: "A session assigned work", short: "Assigned work", tone: "muted" });
    expect(notificationVerbs({ kind: "peer_message", intent: "blocker" })).toEqual({ verb: "A session reported a blocker", short: "Reported a blocker", tone: "warning" });
    expect(notificationVerbs({ kind: "peer_message", intent: "result" })).toEqual({ verb: "A session sent a result", short: "Sent a result", tone: "muted" });
    expect(notificationVerbs({ kind: "peer_message", intent: "report" })).toEqual({ verb: "A session sent a message", short: "Sent a message", tone: "muted" });
    // NO INTENT IS `report`, not a wake — the fall-through that started #572.
    expect(notificationVerbs({ kind: "peer_message" }).verb).toBe("A session sent a message");
  });

  test("a wake is named by its transition", () => {
    expect(notificationVerbs({ kind: "wake", wakeKind: "turn_completed" })).toEqual({ verb: "Session finished a turn", short: "Finished", tone: "muted" });
    expect(notificationVerbs({ kind: "wake", wakeKind: "turn_failed" })).toEqual({ verb: "Session failed a turn", short: "Failed", tone: "warning" });
    expect(notificationVerbs({ kind: "wake", wakeKind: "turn_stopped" })).toEqual({ verb: "Session was stopped", short: "Stopped", tone: "muted" });
  });

  test("a parked request is the same happening under either spelling", () => {
    const asKind = notificationVerbs({ kind: "request" });
    expect(asKind).toEqual({ verb: "Session asked a question", short: "Waiting on you", tone: "warning" });
    expect(notificationVerbs({ kind: "request", wakeKind: "request_opened" })).toEqual(asKind);
    expect(notificationVerbs({ kind: "wake", wakeKind: "request_opened" })).toEqual(asKind);
  });

  // A NEWER ENGINE'S VOCABULARY IS STILL A NOTIFICATION. Vague beats blank.
  test("a wake with no transition still says something true", () => {
    expect(notificationVerbs({ kind: "wake" })).toEqual({ verb: "Session activity", short: "Activity", tone: "muted" });
  });

  // THE CLASSIFICATION IS SHARED; ONLY THE REGISTER IS THE STRIP'S. A result and
  // a completion differ in BOTH vocabularies or the strip has the bug the row
  // just lost.
  test("a peer's result and a completion differ in both registers", () => {
    const result = notificationVerbs({ kind: "peer_message", intent: "result" });
    const finished = notificationVerbs({ kind: "wake", wakeKind: "turn_completed" });
    expect(result.verb).not.toBe(finished.verb);
    expect(result.short).not.toBe(finished.short);
  });
});

describe("an inbox row is the same happening", () => {
  test("the strip's flat kind maps onto the three notification kinds", () => {
    expect(inboxSubject({ kind: "peer_message", intent: "result" })).toEqual({ kind: "peer_message", intent: "result" });
    expect(inboxSubject({ kind: "peer_message" })).toEqual({ kind: "peer_message" });
    expect(inboxSubject({ kind: "request_opened" })).toEqual({ kind: "request", wakeKind: "request_opened" });
    expect(inboxSubject({ kind: "turn_completed" })).toEqual({ kind: "wake", wakeKind: "turn_completed" });
    expect(inboxSubject({ kind: "turn_failed" })).toEqual({ kind: "wake", wakeKind: "turn_failed" });
    expect(inboxSubject({ kind: "turn_stopped" })).toEqual({ kind: "wake", wakeKind: "turn_stopped" });
  });
});

describe("the head of what was sent", () => {
  test("the first line with anything on it, without the engine's bracketed kind", () => {
    expect(notificationHead("[agent message · result] Three commits landed\n—\nmore")).toBe("Three commits landed");
    expect(notificationHead("\n\n  Rewrite the parser  \nsecond line")).toBe("Rewrite the parser");
  });

  test("nothing to show is nothing, not an empty row", () => {
    expect(notificationHead(undefined)).toBeUndefined();
    expect(notificationHead("")).toBeUndefined();
    expect(notificationHead("   \n  ")).toBeUndefined();
    // A line that is ONLY the engine's kind has no head left once it is stripped.
    expect(notificationHead("[wake: completed]")).toBeUndefined();
  });

  test("a long line is cut, and MARKED where — a reader must not have to guess", () => {
    const head = notificationHead("x".repeat(500));
    expect(head).toHaveLength(NOTIFICATION_HEAD_CHARS);
    expect(head?.endsWith("…")).toBe(true);
    // Exactly the limit is not cut.
    expect(notificationHead("y".repeat(NOTIFICATION_HEAD_CHARS))).toBe("y".repeat(NOTIFICATION_HEAD_CHARS));
  });

  test("the bracketed kind is stripped once, and only from the front", () => {
    expect(stripNotificationKind("[wake: completed] Session session_a — turn run_a completed.")).toBe("Session session_a — turn run_a completed.");
    expect(stripNotificationKind("no bracket here")).toBe("no bracket here");
    expect(stripNotificationKind("plain [not a kind]")).toBe("plain [not a kind]");
  });
});
