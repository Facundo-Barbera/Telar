/**
 * The triage cache's invalidation.
 *
 * This is the cheap half of the most expensive thing the system does. If
 * `staleItems` over-reports, every tick re-reads every comment thread and the
 * cost of triage goes back to what it was before the cache existed. If it
 * under-reports, the orchestrator dispatches on a classification that a comment
 * has since retracted. Both are asserted here.
 */
import { describe, expect, test } from "bun:test";
import type { TriageEntry } from "@telar/engine-client";
import { pruneCache, staleItems, type TriageCache } from "../src/loom/triage";

const at = 1_700_000_000_000;

const entry = (item: string, updatedAt: string): TriageEntry => ({
  item,
  updatedAt,
  classification: "needs-decision",
  reason: "los puntos 2 y 3 son decisión de JMB",
  ask: "decide on points 2 and 3 first",
  at,
});

const cache: TriageCache = {
  "#457": entry("#457", "2026-08-19T22:00:00Z"),
  "#464": entry("#464", "2026-08-18T10:00:00Z"),
};

describe("staleItems", () => {
  test("an item nobody has classified is stale", () => {
    expect(staleItems(cache, [{ item: "#999", updatedAt: "whenever" }])).toEqual(["#999"]);
  });

  test("an item whose revision token moved is stale", () => {
    expect(staleItems(cache, [{ item: "#457", updatedAt: "2026-08-20T09:00:00Z" }])).toEqual(["#457"]);
  });

  test("an unchanged item is NOT stale — this is the whole saving", () => {
    expect(staleItems(cache, [{ item: "#457", updatedAt: "2026-08-19T22:00:00Z" }])).toEqual([]);
  });

  test("the token is compared for equality, never for order", () => {
    // An OLDER token is still a difference: the list is the authority on what
    // the current revision is, and a sha or an mtime has no ordering we may
    // assume anyway.
    expect(staleItems(cache, [{ item: "#457", updatedAt: "2020-01-01T00:00:00Z" }])).toEqual(["#457"]);
    // Non-date tokens work identically.
    const shas: TriageCache = { "#1": entry("#1", "9f8c1a2") };
    expect(staleItems(shas, [{ item: "#1", updatedAt: "9f8c1a2" }])).toEqual([]);
    expect(staleItems(shas, [{ item: "#1", updatedAt: "0000000" }])).toEqual(["#1"]);
  });

  test("list order is preserved, because it is the project's own priority", () => {
    const stale = staleItems(cache, [
      { item: "#3", updatedAt: "x" },
      { item: "#457", updatedAt: "2026-08-19T22:00:00Z" }, // fresh, skipped
      { item: "#1", updatedAt: "x" },
      { item: "#2", updatedAt: "x" },
    ]);
    expect(stale).toEqual(["#3", "#1", "#2"]);
  });

  test("a duplicated item is read once", () => {
    expect(staleItems({}, [{ item: "#1", updatedAt: "a" }, { item: "#1", updatedAt: "b" }])).toEqual(["#1"]);
  });

  test("an empty list is nothing to do; an empty cache is everything to do", () => {
    expect(staleItems(cache, [])).toEqual([]);
    expect(staleItems({}, [{ item: "#1", updatedAt: "a" }, { item: "#2", updatedAt: "b" }])).toEqual(["#1", "#2"]);
  });
});

describe("pruneCache", () => {
  test("drops what the project no longer lists", () => {
    const pruned = pruneCache(cache, [{ item: "#457" }]);
    expect(Object.keys(pruned)).toEqual(["#457"]);
  });

  test("keeps the entry intact, not a copy that lost its ask", () => {
    expect(pruneCache(cache, [{ item: "#464" }])["#464"]).toEqual(cache["#464"] as TriageEntry);
  });

  test("an empty list empties the cache", () => {
    expect(pruneCache(cache, [])).toEqual({});
  });

  test("it is pure — the original cache is untouched", () => {
    pruneCache(cache, []);
    expect(Object.keys(cache).sort()).toEqual(["#457", "#464"]);
  });

  test("listing an item that was never cached adds nothing", () => {
    expect(pruneCache(cache, [{ item: "#999" }])).toEqual({});
  });
});
