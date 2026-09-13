// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_INBOX_POLICY, DEFAULT_SETTLE_DELEGATED_AFTER_HOURS } from "@telar/engine-client";

/**
 * THE SETTLING GROUP HOLDS TWO CLOCKS NOW — issue #378, and they are two
 * because they measure different things: one guesses from silence, the other
 * counts from a delivery the engine stamped.
 *
 * READ AS SOURCE rather than rendered, because this section is a client
 * component whose whole body hangs off `useInboxPolicy` — a hook that reads the
 * address bar and fetches. A server render would exercise the mocks, not the
 * rows. What is worth pinning is the shape: two independent switches, each with
 * its own duration underneath, on the shared `Row` grammar.
 */
const source = readFileSync(new URL("./inbox-section.tsx", import.meta.url), "utf8");

test("the delegation row says what it does, in the issue's own words", () => {
  expect(source).toContain("Settle delegated conversations after their result is delivered");
});

test("the two windows are patched independently", () => {
  // ONE PATCH PER KEY. Sending both on either change is how turning the
  // delegation settling off would quietly rewrite the quiet window as well.
  expect(source).toContain("save({ settleDelegatedAfterHours: next })");
  expect(source).toContain("save({ autoSettleAfterHours: next })");
  expect(source).not.toContain("autoSettleAfterHours: next, settleDelegatedAfterHours");
});

test("each duration appears only while its own switch is on", () => {
  expect(source).toContain("{hours !== null && (");
  expect(source).toContain("{delegated !== null && (");
});

test("both rows revert to the shared default, and the defaults are the protocol's", () => {
  expect(source).toContain("DEFAULT_INBOX_POLICY.settleDelegatedAfterHours");
  expect(source).toContain("DEFAULT_SETTLE_DELEGATED_AFTER_HOURS");
  // An hour, not the quiet window's three days — see `InboxPolicy`.
  expect(DEFAULT_INBOX_POLICY.settleDelegatedAfterHours).toBe(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS);
  expect(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS).toBe(1);
  expect(DEFAULT_INBOX_POLICY.autoSettleAfterHours).not.toBe(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS);
});

test("the two duration inputs are labelled apart", () => {
  // They are the same component twice. Without distinct labels a screen reader
  // meets two identical spinners and cannot tell which clock it is setting.
  expect(source).toContain("How long a session must be quiet before it settles");
  expect(source).toContain("How long after delivery a delegated conversation settles");
});
