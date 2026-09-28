// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { FOLLOW_SLACK_PX, READER_GESTURE_MS, shouldRefollow } from "./scroll-follow";

/** The reported case: a transcript that quietly stopped following its own tail
 *  while a reply streamed, with nobody having touched it. */
const spurious = { escaped: true, distance: 0, gestureAgo: Number.POSITIVE_INFINITY };

describe("an escape nobody performed", () => {
  test("is undone — the transcript is sitting at its own end", () => {
    expect(shouldRefollow(spurious)).toBe(true);
  });

  // The pacer reveals a line at a time, so the viewport is at most one
  // increment behind the end when the lock drops mid-answer.
  test("is undone anywhere inside the library's own near-bottom slack", () => {
    expect(shouldRefollow({ ...spurious, distance: FOLLOW_SLACK_PX })).toBe(true);
    expect(shouldRefollow({ ...spurious, distance: FOLLOW_SLACK_PX + 1 })).toBe(false);
  });

  test("is not undone from far up the transcript — something put the reader there", () => {
    expect(shouldRefollow({ ...spurious, distance: 900 })).toBe(false);
  });
});

describe("an escape the reader performed", () => {
  // THE HALF THAT MUST NOT REGRESS. Scrolling up to re-read something during a
  // long turn is the entire reason the lock exists.
  test("survives, even from one notch above the end", () => {
    expect(shouldRefollow({ escaped: true, distance: 8, gestureAgo: 0 })).toBe(false);
    expect(shouldRefollow({ escaped: true, distance: 8, gestureAgo: READER_GESTURE_MS })).toBe(false);
  });

  test("stops being theirs once the gesture is old enough to be unrelated", () => {
    expect(shouldRefollow({ escaped: true, distance: 8, gestureAgo: READER_GESTURE_MS + 1 })).toBe(true);
  });

  // Momentum keeps wheel events arriving for the length of a flick; the window
  // has to outlast one, and the library decides a whole scroll event later.
  test("covers the flick and the library's own 1ms deferral", () => {
    expect(READER_GESTURE_MS).toBeGreaterThan(200);
  });
});

describe("a transcript that never stopped following", () => {
  test("is left alone — re-pinning it would fight its own animation", () => {
    expect(shouldRefollow({ escaped: false, distance: 0, gestureAgo: Number.POSITIVE_INFINITY })).toBe(false);
    expect(shouldRefollow({ escaped: false, distance: 900, gestureAgo: 0 })).toBe(false);
  });
});
