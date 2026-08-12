/**
 * The panel's four surfaces are FOLDS over the session record, and the folds are
 * where the judgement lives. This used to assert the panel's prose — back when
 * the panel's whole content was a sentence explaining that it had none — which
 * pinned copy rather than behaviour and went stale the moment it gained tabs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { isLiveTask, isPanelTab, journalWrites, latestBrowserState, openFilePaths, sessionUsage } from "./right-panel";

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

describe("journalWrites", () => {
  test("counts every write per path, whatever order they arrive in", () => {
    // The count is the one fact git cannot state: a file rewritten twice has the
    // same net diff as a file written once, and the Diff surface badges it `×2`.
    const writes = journalWrites([
      fileChange({ path: "a.ts", at: 200, linesAdded: 9 }),
      fileChange({ path: "a.ts", at: 100, linesAdded: 1 }),
      fileChange({ path: "b.ts", at: 150 }),
    ]);
    expect([...writes]).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });

  test("omits changes that never landed", () => {
    // Counting a declined or failed change would claim the session edited a file
    // it did not — and on the Diff surface that would move the row from "not in
    // the transcript" to "the session wrote this", which is the most damaging
    // kind of wrong this fold can be.
    expect(journalWrites([fileChange({ path: "a.ts", at: 1, status: "declined" })]).size).toBe(0);
    expect(journalWrites([fileChange({ path: "b.ts", at: 1, status: "failed" })]).size).toBe(0);
  });
});

describe("file tabs", () => {
  test("a path with a colon in it survives the round trip", () => {
    // The tab id is `file:<path>` and a colon is legal in a filename, so the
    // split has to be on the FIRST separator only.
    expect(openFilePaths(["files", "file:src/weird:name.ts", "browser:tab_1"])).toEqual(["src/weird:name.ts"]);
  });

  test("a bare `file:` is not a tab", () => {
    // It names nothing, so restoring it from localStorage would produce a tab
    // that can only ever fail to load.
    expect(isPanelTab("file:src/a.ts")).toBe(true);
    expect(isPanelTab("file:")).toBe(false);
    // And the renamed surfaces are what this build understands.
    expect(isPanelTab("diff")).toBe(true);
    expect(isPanelTab("files")).toBe(true);
    expect(isPanelTab("changes")).toBe(false);
    expect(isPanelTab("git")).toBe(false);
  });
});

describe("sessionUsage", () => {
  test("distinguishes 'reported nothing' from 'spent nothing'", () => {
    // The surface renders an em dash for `undefined` and a number for 0. A fold
    // that returned 0 here would state a figure the provider never gave.
    const none = sessionUsage([{ runId: "run_1" } as Turn]);
    expect(none.input).toBeUndefined();
    expect(none.output).toBeUndefined();
    expect(none.reported).toBe(0);
    expect(none.turns).toBe(1);
  });

  test("totals only the turns that reported, and says how many that was", () => {
    const usage = sessionUsage([turnWithUsage(10, 5, 0.01), { runId: "bare" } as Turn, turnWithUsage(20, 1)]);
    expect(usage.input).toBe(30);
    expect(usage.output).toBe(6);
    // The provider's price is still on the contract and is NOT folded here:
    // money is not a unit this cockpit reports. See lib/format.ts.
    expect(usage).not.toHaveProperty("costUsd");
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
