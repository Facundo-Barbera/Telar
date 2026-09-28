// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageLimitAccount } from "@telar/engine-client";
import { fmtUntil, pooledRemaining, ProviderCard, remainingPercent } from "./usage-limits";

/**
 * The Limits section's arithmetic and its one visual invariant.
 *
 * Both providers report how much of a window is USED and a person wants to know
 * what is LEFT, so the complement is taken in exactly one place — and a bar that
 * could not be read must not be drawn as a bar that is empty, because those are
 * opposite instructions.
 */

const claude = (id: string, usedPercent: number): UsageLimitAccount => ({
  id,
  driver: "claude",
  email: `${id}@example.com`,
  plan: "Claude subscription",
  windows: [
    { key: "five_hour", label: "5-hour", usedPercent, resetsAt: 2_000 },
    { key: "seven_day", label: "7-day", usedPercent: 10 },
  ],
});

test("remaining is the complement of used, clamped", () => {
  expect(remainingPercent({ key: "five_hour", label: "5-hour", usedPercent: 25 })).toBe(75);
  expect(remainingPercent({ key: "five_hour", label: "5-hour", usedPercent: 140 })).toBe(0);
  expect(remainingPercent(undefined)).toBeUndefined();
});

test("the pooled figure averages the seats that answered and ignores the ones that did not", () => {
  const unread: UsageLimitAccount = { id: "c", driver: "claude", windows: [], error: "The hub could not read this account's usage." };
  expect(pooledRemaining([claude("a", 0), claude("b", 50)])).toBe(75);
  // An account with no reading is NOT averaged in as full and NOT as empty —
  // it is left out, and the card reports how many were.
  expect(pooledRemaining([claude("a", 0), claude("b", 50), unread])).toBe(75);
  expect(pooledRemaining([unread])).toBeUndefined();
});

test("the headline window is per driver, with a fallback to whatever there is", () => {
  // Claude reads its 5-hour window, not the 7-day one that follows it.
  expect(pooledRemaining([claude("a", 40)])).toBe(60);
  const codex: UsageLimitAccount = {
    id: "x",
    driver: "codex",
    windows: [
      { key: "secondary", label: "Secondary", usedPercent: 90 },
      { key: "primary", label: "Primary", usedPercent: 20 },
    ],
  };
  // Order in the array does not decide it; the key does.
  expect(pooledRemaining([codex])).toBe(80);
  const odd: UsageLimitAccount = { id: "y", driver: "codex", windows: [{ key: "weekly", label: "Weekly", usedPercent: 30 }] };
  expect(pooledRemaining([odd])).toBe(70);
});

test("a countdown coarsens as it recedes and never reads as a negative", () => {
  const now = 1_000_000_000_000;
  expect(fmtUntil(now - 5_000, now)).toBe("now");
  expect(fmtUntil(now + 30_000, now)).toBe("in under a minute");
  expect(fmtUntil(now + 12 * 60_000, now)).toBe("in 12m");
  expect(fmtUntil(now + 3 * 3_600_000 + 5 * 60_000, now)).toBe("in 3h 5m");
  expect(fmtUntil(now + 2 * 86_400_000 + 3_600_000, now)).toBe("in 2d 1h");
  expect(fmtUntil(now + 9 * 86_400_000, now)).toBe("in 9d");
});

test("each seat is one segment and its fill is what is left of it", () => {
  const html = renderToStaticMarkup(<ProviderCard driver="claude" accounts={[claude("a", 25), claude("b", 60)]} />);
  expect(html).toContain("height:75%");
  expect(html).toContain("height:40%");
  // The pooled figure sits on the header, rounded.
  expect(html).toContain(">58%<");
  expect(html).toContain("2 accounts");
});

test("a seat whose read failed is hatched, not drawn as an empty bar", () => {
  const unread: UsageLimitAccount = { id: "c", driver: "claude", email: "c@example.com", windows: [], error: "The hub could not read this account's usage." };
  const html = renderToStaticMarkup(<ProviderCard driver="claude" accounts={[claude("a", 25), unread]} />);
  expect(html).toContain("repeating-linear-gradient");
  // …and specifically NOT a zero-height fill, which is what "all used up" looks
  // like. The card also says how many seats went unread.
  expect(html).not.toContain("height:0%");
  expect(html).toContain("1 unread");
  // The segment's own label carries the hub's sentence, so hovering the hatch
  // says why rather than leaving the reader to guess at a texture.
  expect(html).toContain("The hub could not read this account&#x27;s usage.");
  // Only the seats that answered are averaged — see `pooledRemaining`.
  expect(html).toContain(">75%<");
});
