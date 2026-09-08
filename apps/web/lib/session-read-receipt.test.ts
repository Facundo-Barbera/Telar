// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ReceiptAnswer, ReceiptIdentity, ResultTurn } from "./session-read-receipt";
import {
  isResultTurn,
  newestResultTurn,
  ReadReceiptCourier,
  receiptRetryDelayMs,
  receiptToSend,
  RECEIPT_MAX_ATTEMPTS,
} from "./session-read-receipt";

const turn = (sequence: number, state: ResultTurn["state"] = "completed"): ResultTurn => ({
  runId: `run-${sequence}`,
  state,
  sequence,
});

const open = { foreground: true, atLatestResult: true, loading: false };

describe("which turn a receipt may name", () => {
  test("the three states that leave an answer, and only those", () => {
    expect(isResultTurn({ state: "completed" })).toBe(true);
    expect(isResultTurn({ state: "failed" })).toBe(true);
    expect(isResultTurn({ state: "stopped" })).toBe(true);
    // A message steered into a running turn is the human's own words, and the
    // transcript does not draw it as a turn at all.
    expect(isResultTurn({ state: "steering" })).toBe(false);
    expect(isResultTurn({ state: "steered" })).toBe(false);
    // A dismissed recovery is not an answer; nor is a turn still asking for a
    // recovery decision, or one still running.
    expect(isResultTurn({ state: "discarded" })).toBe(false);
    expect(isResultTurn({ state: "ambiguous" })).toBe(false);
    expect(isResultTurn({ state: "running" })).toBe(false);
    expect(isResultTurn({ state: "queued" })).toBe(false);
  });

  test("the newest by SEQUENCE, not by position", () => {
    expect(newestResultTurn([turn(3), turn(9), turn(7)])?.sequence).toBe(9);
    expect(newestResultTurn([])).toBeUndefined();
  });

  test("a steered message after the last answer does not become the candidate", () => {
    // The exact shape that used to strand a session: the newest ENDED turn is
    // not the newest ANSWER, and only the answer can be marked read.
    expect(newestResultTurn([turn(4), turn(5, "steered"), turn(6, "discarded")])?.sequence).toBe(4);
  });

  test("a running turn does not hide the answer above it", () => {
    expect(newestResultTurn([turn(4), turn(5, "running")])?.sequence).toBe(4);
  });
});

describe("the gate", () => {
  test("all four conditions, or nothing is sent", () => {
    expect(receiptToSend({ candidate: turn(2), gate: open })?.runId).toBe("run-2");
    // A hidden or unfocused window has nobody in front of it.
    expect(receiptToSend({ candidate: turn(2), gate: { ...open, foreground: false } })).toBeUndefined();
    // Scrolled up re-reading an old answer: the new one is not on screen.
    expect(receiptToSend({ candidate: turn(2), gate: { ...open, atLatestResult: false } })).toBeUndefined();
    // Mid-hydrate what is on screen is the previous render, or nothing.
    expect(receiptToSend({ candidate: turn(2), gate: { ...open, loading: true } })).toBeUndefined();
    // Nothing has answered yet.
    expect(receiptToSend({ gate: open })).toBeUndefined();
  });

  test("an answer the engine already has a receipt for is not resent", () => {
    expect(receiptToSend({ candidate: turn(5), readSequence: 5, gate: open })).toBeUndefined();
    expect(receiptToSend({ candidate: turn(5), readSequence: 4, gate: open })?.sequence).toBe(5);
    // A receipt from another device, for a LATER turn, wins over ours.
    expect(receiptToSend({ candidate: turn(5), readSequence: 9, gate: open })).toBeUndefined();
  });

  test("one in flight is not sent twice while it lands", () => {
    // The round trip is why this is separate from `readSequence`: without it a
    // visible answer would be reported once per render until the answer came
    // back.
    expect(receiptToSend({ candidate: turn(5), confirmedSequence: 5, gate: open })).toBeUndefined();
    expect(receiptToSend({ candidate: turn(6), confirmedSequence: 5, gate: open })?.sequence).toBe(6);
  });
});

describe("retrying", () => {
  test("bounded, and backing off", () => {
    expect(RECEIPT_MAX_ATTEMPTS).toBe(3);
    expect(receiptRetryDelayMs(1)).toBe(1_000);
    expect(receiptRetryDelayMs(2)).toBe(2_000);
    // Capped, so a long-dead engine is not retried on an ever-growing timer
    // that fires the moment it comes back for every open tab at once.
    expect(receiptRetryDelayMs(50)).toBe(8_000);
  });
});

/**
 * THE LIFECYCLE, which is where every real defect in this feature has been.
 *
 * `receiptToSend` above is a decision about one render and cannot express any
 * of these: they are all about a REQUEST OUTLIVING the thing it was about — its
 * session, its host, or a later receipt. Driven with deferred promises and a
 * hand-run clock, because "resolve this one AFTER that one" is the whole point
 * and a real timer cannot say it.
 */
describe("the courier", () => {
  const A = { sessionId: "session_a", hostId: "local" };
  /** The SAME session id on a different Mac — a different session entirely. */
  const A_REMOTE = { sessionId: "session_a", hostId: "mini" };
  const B = { sessionId: "session_b", hostId: "local" };

  type Deferred = { runId: string; identity: ReceiptIdentity; resolve: (answer: ReceiptAnswer) => void; reject: () => void };

  /** A courier with its clock and its network in the test's hands. */
  function harness() {
    const sent: Deferred[] = [];
    const read: { identity: ReceiptIdentity; answer: ReceiptAnswer }[] = [];
    let timers: { id: number; run: () => void }[] = [];
    let nextTimer = 1;
    const courier = new ReadReceiptCourier({
      send: (identity, runId) =>
        new Promise<ReceiptAnswer>((resolve, reject) => {
          sent.push({ runId, identity, resolve, reject: () => reject(new Error("engine unavailable")) });
        }),
      onRead: (identity, answer) => read.push({ identity, answer }),
      setTimer: (run) => {
        const id = nextTimer++;
        timers.push({ id, run });
        return id;
      },
      clearTimer: (timer) => {
        timers = timers.filter((entry) => entry.id !== timer);
      },
    });
    return {
      courier,
      sent,
      read,
      /** Fire every armed timer — the dwell elapsing. */
      tick: () => {
        const due = timers;
        timers = [];
        for (const timer of due) timer.run();
      },
      armed: () => timers.length,
      /** Let the promise callbacks the test just resolved actually run. */
      settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    };
  }

  const open = (identity: ReceiptIdentity, candidate: ResultTurn, readSequence?: number) => ({
    identity,
    candidate,
    ...(readSequence === undefined ? {} : { readSequence }),
    gate: { foreground: true, atLatestResult: true, loading: false },
  });

  test("the dwell is a dwell: scrolling away before it elapses sends nothing", () => {
    const h = harness();
    h.courier.update(open(A, turn(1)));
    expect(h.armed()).toBe(1);
    h.courier.update({ ...open(A, turn(1)), gate: { foreground: true, atLatestResult: false, loading: false } });
    expect(h.armed()).toBe(0);
    h.tick();
    expect(h.sent).toHaveLength(0);
  });

  test("one receipt per answer, however many renders", async () => {
    const h = harness();
    h.courier.update(open(A, turn(1)));
    h.tick();
    expect(h.sent).toHaveLength(1);
    // Re-rendered while it is in flight: the sequence is already claimed.
    h.courier.update(open(A, turn(1)));
    h.tick();
    expect(h.sent).toHaveLength(1);
    h.sent[0]!.resolve({ lastReadTurnSequence: 1, readAt: 5 });
    await h.settle();
    expect(h.read).toEqual([{ identity: A, answer: { lastReadTurnSequence: 1, readAt: 5 } }]);
  });

  describe("a receipt that outlives what it was about", () => {
    test("A → B in the same mounted cockpit: A's answer never reaches B", async () => {
      const h = harness();
      h.courier.update(open(A, turn(4)));
      h.tick();
      expect(h.sent).toHaveLength(1);

      // The reader opens another session. B's turn 2 is a LOWER sequence than
      // A's 4 — which is exactly what a shared high-water mark would swallow.
      h.courier.update(open(B, turn(2)));
      h.sent[0]!.resolve({ lastReadTurnSequence: 4, readAt: 9 });
      await h.settle();
      // A's answer is dropped whole: no callback, and B's bookkeeping untouched.
      expect(h.read).toHaveLength(0);
      h.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1]).toMatchObject({ identity: B, runId: "run-2" });
    });

    test("the same session id on another Mac is a different session", async () => {
      const h = harness();
      h.courier.update(open(A, turn(4)));
      h.tick();
      h.courier.update(open(A_REMOTE, turn(1)));
      h.sent[0]!.resolve({ lastReadTurnSequence: 4 });
      await h.settle();
      expect(h.read).toHaveLength(0);
      h.tick();
      expect(h.sent[1]).toMatchObject({ identity: A_REMOTE, runId: "run-1" });
    });

    test("a stale FAILURE spends none of the new session's attempts", async () => {
      const h = harness();
      h.courier.update(open(A, turn(4)));
      h.tick();
      h.courier.update(open(B, turn(2)));
      h.sent[0]!.reject();
      await h.settle();
      // B is still on its first attempt: its dwell, not a retry backoff.
      h.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1]).toMatchObject({ identity: B });
    });

    test("disposing drops everything still in flight", async () => {
      const h = harness();
      h.courier.update(open(A, turn(1)));
      h.tick();
      h.courier.dispose();
      h.sent[0]!.resolve({ lastReadTurnSequence: 1 });
      await h.settle();
      expect(h.read).toHaveLength(0);
    });
  });

  describe("two answers in flight at once", () => {
    test("an OLD FAILURE after a NEW SUCCESS cannot drag the mark back", async () => {
      const h = harness();
      h.courier.update(open(A, turn(5)));
      h.tick();
      const five = h.sent[0]!;
      // A sixth answer arrives before the fifth's receipt has landed.
      h.courier.update(open(A, turn(6)));
      h.tick();
      const six = h.sent[1]!;
      expect(six).toMatchObject({ runId: "run-6" });

      six.resolve({ lastReadTurnSequence: 6, readAt: 60 });
      await h.settle();
      five.reject();
      await h.settle();

      // The failure releases its own claim and nothing else: no receipt for 5,
      // and no second one for 6.
      h.courier.update(open(A, turn(6), 6));
      h.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.read).toEqual([{ identity: A, answer: { lastReadTurnSequence: 6, readAt: 60 } }]);
    });

    test("an OLD SUCCESS after a newer read is reported but claims nothing further", async () => {
      const h = harness();
      h.courier.update(open(A, turn(5)));
      h.tick();
      const five = h.sent[0]!;
      h.courier.update(open(A, turn(6)));
      h.tick();
      h.sent[1]!.resolve({ lastReadTurnSequence: 6, readAt: 60 });
      await h.settle();
      five.resolve({ lastReadTurnSequence: 6, readAt: 60 });
      await h.settle();

      // Both are handed up — the CALLER folds them monotonically, and the
      // engine's own answer already carries the higher mark either way — but
      // nothing is re-sent for a turn that is behind.
      expect(h.read).toHaveLength(2);
      h.courier.update(open(A, turn(6), 6));
      h.tick();
      expect(h.sent).toHaveLength(2);
    });
  });

  describe("the attempt budget", () => {
    test("is bounded per answer, and handed back when the reader looks again", async () => {
      const h = harness();
      const looking = open(A, turn(1));
      const away = { ...looking, gate: { foreground: true, atLatestResult: false, loading: false } };
      for (let attempt = 0; attempt < RECEIPT_MAX_ATTEMPTS; attempt += 1) {
        h.tick();
        h.courier.update(looking);
        h.tick();
        h.sent[attempt]!.reject();
        await h.settle();
      }
      expect(h.sent).toHaveLength(RECEIPT_MAX_ATTEMPTS);
      // Spent: further renders arm nothing.
      h.courier.update(looking);
      h.tick();
      expect(h.sent).toHaveLength(RECEIPT_MAX_ATTEMPTS);
      // Scrolled away and back — the reader looking again is a fresh start.
      h.courier.update(away);
      h.courier.update(looking);
      h.tick();
      expect(h.sent).toHaveLength(RECEIPT_MAX_ATTEMPTS + 1);
    });
  });
});
