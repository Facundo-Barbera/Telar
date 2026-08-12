/**
 * The panel's four surfaces are FOLDS over the session record, and the folds are
 * where the judgement lives. This used to assert the panel's prose — back when
 * the panel's whole content was a sentence explaining that it had none — which
 * pinned copy rather than behaviour and went stale the moment it gained tabs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { changedFiles, isLiveTask, latestBrowserState, sessionUsage } from "./right-panel";

function fileChange(overrides: {
  path: string;
  at: number;
  status?: Item["status"];
  kind?: "create" | "edit" | "delete" | "rename";
  linesAdded?: number;
}): Item {
  return {
    id: `item_${overrides.path}_${overrides.at}`,
    sessionId: "session_1",
    runId: "run_1",
    status: overrides.status ?? "completed",
    startedAt: overrides.at,
    completedAt: overrides.at,
    detail: {
      type: "file_change",
      change: {
        path: overrides.path,
        kind: overrides.kind ?? "edit",
        ...(overrides.linesAdded === undefined ? {} : { linesAdded: overrides.linesAdded }),
      },
    },
  } as Item;
}

function turnWithUsage(input: number, output: number, costUsd?: number): Turn {
  return {
    runId: `run_${input}`,
    usage: {
      tokens: { input, output, cacheRead: 0, cacheCreate: 0 },
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  } as Turn;
}

describe("changedFiles", () => {
  test("keeps the NEWEST change per path and counts the earlier ones", () => {
    // The row shows one change, so the count is the only honest signal that
    // there were others — and the fold must not depend on arrival order.
    const files = changedFiles([
      fileChange({ path: "a.ts", at: 200, linesAdded: 9 }),
      fileChange({ path: "a.ts", at: 100, linesAdded: 1 }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].edits).toBe(2);
    expect(files[0].linesAdded).toBe(9);
  });

  test("omits changes that never landed", () => {
    // Listing a declined or failed change would claim the session edited a file
    // it did not — the most damaging kind of wrong a diff list can be.
    expect(changedFiles([fileChange({ path: "a.ts", at: 1, status: "declined" })])).toEqual([]);
    expect(changedFiles([fileChange({ path: "b.ts", at: 1, status: "failed" })])).toEqual([]);
  });

  test("orders by most recently touched", () => {
    const files = changedFiles([fileChange({ path: "old.ts", at: 10 }), fileChange({ path: "new.ts", at: 20 })]);
    expect(files.map((file) => file.path)).toEqual(["new.ts", "old.ts"]);
  });
});

describe("sessionUsage", () => {
  test("distinguishes 'reported nothing' from 'spent nothing'", () => {
    // The surface renders an em dash for `undefined` and a number for 0. A fold
    // that returned 0 here would state a figure the provider never gave.
    const none = sessionUsage([{ runId: "run_1" } as Turn]);
    expect(none.input).toBeUndefined();
    expect(none.costUsd).toBeUndefined();
    expect(none.reported).toBe(0);
    expect(none.turns).toBe(1);
  });

  test("totals only the turns that reported, and says how many that was", () => {
    const usage = sessionUsage([turnWithUsage(10, 5, 0.01), { runId: "bare" } as Turn, turnWithUsage(20, 1)]);
    expect(usage.input).toBe(30);
    expect(usage.output).toBe(6);
    // One turn reported tokens with no price; the price total is still the sum
    // of the prices that DID arrive rather than being discarded.
    expect(usage.costUsd).toBeCloseTo(0.01, 10);
    expect(usage.reported).toBe(2);
    expect(usage.turns).toBe(3);
  });
});

describe("latestBrowserState", () => {
  test("replaces rather than merges, because the event carries the whole tab set", () => {
    const events = [
      { type: "browser.state.changed", provider: "headless", tabs: [{ id: "1" }, { id: "2" }] },
      { type: "browser.state.changed", provider: "headless", tabs: [{ id: "3" }] },
    ] as unknown as EngineEvent[];
    expect(latestBrowserState(events)?.tabs.map((tab) => tab.id)).toEqual(["3"]);
  });

  test("is undefined when the session has never browsed", () => {
    expect(latestBrowserState([])).toBeUndefined();
  });
});

describe("isLiveTask", () => {
  test("counts waiting as live — a blocked sub-agent has not finished", () => {
    for (const state of ["pending", "running", "waiting"]) {
      expect(isLiveTask({ state } as Task)).toBe(true);
    }
    for (const state of ["completed", "failed", "stopped"]) {
      expect(isLiveTask({ state } as Task)).toBe(false);
    }
  });
});
