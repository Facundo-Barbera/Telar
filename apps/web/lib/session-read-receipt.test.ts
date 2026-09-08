// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ResultTurn } from "./session-read-receipt";
import {
  isResultTurn,
  newestResultTurn,
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
