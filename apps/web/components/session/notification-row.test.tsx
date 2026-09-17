/**
 * THE NOTIFICATION ROW — issue #550's visual half.
 *
 * A peer's message, a wake and a parked request all reached this session
 * without anybody typing, and all three used to be drawn as somebody's bubble:
 * the person's for a wake that landed mid-turn, an agent's dashed card for a
 * peer's. The row under test is neither. What these pin is that it says what
 * happened, that it does not quote a body it only announced, and that the body
 * is one press away when there IS one on this side.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationDetail } from "@telar/engine-client";
import { NotificationRow, notificationLabel } from "../transcript";

const PEER: NotificationDetail = {
  kind: "peer_message",
  sessionId: "session_worker123456",
  runId: "run_report",
  intent: "task",
  summary: "[agent message · task] session session_worker123456 ASSIGNED this session work",
  fetch: { sessionId: "session_host", runId: "run_report" },
  body: '[agent message · task] session session_worker123456 ASSIGNED this session work (run run_report, 42 chars).\n—\nIt opens: "Rewrite the parser"',
};

const render = (detail: NotificationDetail, message?: string) =>
  renderToStaticMarkup(<NotificationRow detail={detail} {...(message ? { message } : {})} />);

test("a peer's message draws a notification row, not a bubble of anyone's", () => {
  const html = render(PEER, "Rewrite the parser's error recovery, and mind the column.");
  expect(html).toContain("A session assigned work");
  // The sender by its id's tail, as every other cross-session row names one.
  expect(html).toContain("session …123456");
  expect(html).toContain('aria-label="Notification"');
  // COLLAPSED BY DEFAULT: the notice is the reason this costs little, and a row
  // that printed it in full would be the body problem drawn instead of sent.
  expect(html).not.toContain("It opens:");
  expect(html).not.toContain("mind the column");
});

test("each kind says which it is", () => {
  expect(notificationLabel(PEER).verb).toBe("A session assigned work");
  expect(notificationLabel({ ...PEER, intent: "blocker" }).verb).toBe("A session reported a blocker");
  expect(notificationLabel({ ...PEER, intent: "result" }).verb).toBe("A session sent a result");
  expect(notificationLabel({ ...PEER, intent: "report" }).verb).toBe("A session sent a message");
  // A wake borrows `sessionWakeLabel`, so a wake that opened its own turn and
  // one that landed mid-turn cannot be given two different names.
  expect(notificationLabel({ ...PEER, kind: "wake", wakeKind: "turn_failed" }).verb).toBe("Session failed a turn");
  expect(notificationLabel({ ...PEER, kind: "request", wakeKind: "request_opened" }).verb).toBe("Session asked a question");
});

test("a cohort says how many things it is, and stays one row", () => {
  const merged: NotificationDetail = {
    ...PEER,
    kind: "wake",
    wakeKind: "turn_completed",
    summary: "[wake: completed] Session session_b — turn run_b completed. (and 2 more)",
    body: "[engine notification · 3 things happened while this session was working]",
    entries: [
      { kind: "wake", runId: "run_a", summary: "a finished" },
      { kind: "wake", runId: "run_b1", summary: "b1 finished" },
      { kind: "wake", runId: "run_b2", summary: "b2 failed" },
    ],
  };
  const html = render(merged);
  expect(html).toContain("and 2 more");
  // ONE row, not three: the reader's question — what happened while I worked —
  // has one answer however many things are in it.
  expect(html.match(/aria-label="Notification"/g)).toHaveLength(1);
});

test("a wake offers no message to read, because there is none on this side", () => {
  // The outcome a wake announces lives in ANOTHER session's run. A button
  // promising a body here would be a dead end.
  const wake: NotificationDetail = { ...PEER, kind: "wake", wakeKind: "turn_completed", body: "[wake: completed] …" };
  expect(render(wake, "a body that is not this turn's")).not.toContain("Read the message");
});
