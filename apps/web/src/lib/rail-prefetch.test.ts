/**
 * THE CAP IS THE WHOLE FEATURE, so it is what is tested.
 *
 * A rail that warms rows is a rail that can warm forty of them — forty route
 * payloads on the heap and forty `/bootstrap` reads against a laptop — and the
 * difference between the fix and that failure is entirely in who gets one of
 * the three slots. Tested against the module singleton rather than a fresh
 * instance, because a singleton is what it is: the rail draws `SessionRow` from
 * five places and the cap has to be counted once across all of them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";
import { LOCAL_HOST } from "@/lib/snapshot-cache";
import { claimPrefetch, PREFETCH_CAP, releasePrefetch, resetPrefetch, warmedRows } from "./rail-prefetch";

beforeEach(() => resetPrefetch());

describe("which rows the rail may open ahead of the click", () => {
  test("the active row plus at most two more", () => {
    expect(PREFETCH_CAP).toBe(3);
    expect(claimPrefetch("active", { active: true })).toBe(true);
    expect(claimPrefetch("near-1")).toBe(true);
    expect(claimPrefetch("near-2")).toBe(true);
    // The fourth row on screen stays cold. A refusal here is the cap working,
    // not a failure — the row simply does not warm.
    expect(claimPrefetch("near-3")).toBe(false);
    expect(warmedRows()).toEqual(["active", "near-1", "near-2"]);
  });

  test("a row already warm is not a second claim, and refreshes its place in line", () => {
    claimPrefetch("a");
    claimPrefetch("b");
    claimPrefetch("c");
    // `a` is oldest until it is asked for again.
    expect(warmedRows()).toEqual(["a", "b", "c"]);
    expect(claimPrefetch("a")).toBe(true);
    expect(warmedRows()).toEqual(["b", "c", "a"]);
    expect(warmedRows()).toHaveLength(PREFETCH_CAP);
  });

  test("pointing at a row evicts the oldest; merely being on screen does not", () => {
    claimPrefetch("oldest");
    claimPrefetch("b");
    claimPrefetch("c");
    // A full cap must never stop the rail warming the row somebody is about to
    // press — so intent takes the oldest slot.
    expect(claimPrefetch("pointed", { intent: true })).toBe(true);
    expect(warmedRows()).toEqual(["b", "c", "pointed"]);
    // …and a row that is merely near the viewport does not get the same
    // licence, or scrolling would evict on every row it passed.
    expect(claimPrefetch("scrolled-past")).toBe(false);
    expect(warmedRows()).toEqual(["b", "c", "pointed"]);
  });

  test("the active row is never evicted — its data is the data on screen", () => {
    claimPrefetch("active", { active: true });
    claimPrefetch("b");
    claimPrefetch("c");
    claimPrefetch("pointed-1", { intent: true });
    claimPrefetch("pointed-2", { intent: true });
    expect(warmedRows()).toContain("active");
    expect(warmedRows()).toHaveLength(PREFETCH_CAP);
  });

  test("the active row always fits, even against a full cap of strangers", () => {
    claimPrefetch("a");
    claimPrefetch("b");
    claimPrefetch("c");
    expect(claimPrefetch("now-active", { active: true })).toBe(true);
    expect(warmedRows()).toEqual(["b", "c", "now-active"]);
  });

  test("a row that became active takes the pin without taking a second slot", () => {
    claimPrefetch("row");
    claimPrefetch("b");
    claimPrefetch("c");
    claimPrefetch("row", { active: true });
    expect(warmedRows()).toHaveLength(PREFETCH_CAP);
    // Pinned now: the two intents below cannot dislodge it.
    claimPrefetch("x", { intent: true });
    claimPrefetch("y", { intent: true });
    expect(warmedRows()).toContain("row");
  });

  test("scrolling a row away gives its slot back", () => {
    claimPrefetch("a");
    claimPrefetch("b");
    claimPrefetch("c");
    expect(claimPrefetch("d")).toBe(false);
    releasePrefetch("b");
    expect(claimPrefetch("d")).toBe(true);
    expect(warmedRows()).toEqual(["a", "c", "d"]);
  });

  test("releasing a row that holds nothing is not an error", () => {
    releasePrefetch("never-warmed");
    expect(warmedRows()).toEqual([]);
  });
});

describe("the key a warm-up is filed under", () => {
  /**
   * `warmConversation` reaches a `SessionConnection` under `hostId ?? LOCAL_HOST`
   * while the cockpit reaches the same one through `hostFromPathname`, which
   * answers `LOCAL_HOST_ID` rather than nothing. If those two ever stopped
   * spelling local the same way, the rail would warm a cache entry the cockpit
   * never reads — and nothing on screen would say so.
   */
  test("local is the same string in the host book and the snapshot cache", () => {
    expect(LOCAL_HOST).toBe(LOCAL_HOST_ID);
  });
});
