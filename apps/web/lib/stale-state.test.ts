/**
 * The one rule the offline cockpit turns on: which failed read keeps the
 * transcript up under a banner, and which one is still an error card.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { decideStale } from "./stale-state";

const NOW = 1_800_000_000_000;

describe("decideStale", () => {
  test("an unreachable engine under a live transcript dates it by the last read", () => {
    expect(decideStale({ code: "engine_unavailable", hasContent: true, lastLiveAt: NOW })).toBe(NOW);
    expect(decideStale({ code: "engine_locked", hasContent: true, lastLiveAt: NOW })).toBe(NOW);
  });

  test("a shown recording keeps its own timestamp, and the newer stamp wins", () => {
    expect(decideStale({ code: "engine_unavailable", hasContent: true, cachedAt: NOW - 5_000 })).toBe(NOW - 5_000);
    expect(decideStale({ code: "engine_unavailable", hasContent: true, cachedAt: NOW - 5_000, lastLiveAt: NOW })).toBe(NOW);
  });

  test("every other failure is still an error", () => {
    expect(decideStale({ code: "not_found", hasContent: true, lastLiveAt: NOW })).toBeUndefined();
    expect(decideStale({ code: "internal_error", hasContent: true, lastLiveAt: NOW })).toBeUndefined();
    expect(decideStale({ hasContent: true, lastLiveAt: NOW })).toBeUndefined();
  });

  test("nothing on screen means nothing to keep", () => {
    expect(decideStale({ code: "engine_unavailable", hasContent: false, lastLiveAt: NOW })).toBeUndefined();
    // Content with no stamp behind it cannot be dated, so it is reported
    // rather than shown under a banner with no time on it.
    expect(decideStale({ code: "engine_unavailable", hasContent: true })).toBeUndefined();
  });
});
