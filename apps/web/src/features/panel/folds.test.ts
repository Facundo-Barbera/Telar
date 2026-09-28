import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task } from "@telar/engine-client";
import { agentBrowserActivity, browserScopeToRelease, describeBrowserStart, isLiveTask, journalWrites, latestBrowserState, splitRoster, tabBadge } from "./folds";
import { LIVE_BROWSER_TAB } from "./model";
import { revealPanelTab, type PanelTabState } from "./tabs";

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

describe("agentBrowserActivity", () => {
  const browsed = (id: number, at: number, pages: number) =>
    ({ id, at, type: "browser.state.changed", provider: "desktop", tabs: Array.from({ length: pages }, (_, n) => ({ id: `p${n}` })) }) as unknown as EngineEvent;

  test("acts on an agent's browsing from after the mount, once", () => {
    const events = [browsed(1, 100, 1), browsed(2, 200, 2)];
    expect(agentBrowserActivity(events, 150, 0)).toEqual({ acted: true, through: 2 });
    // The same array again, resumed where it stopped: nothing new to act on.
    expect(agentBrowserActivity(events, 150, 2)).toEqual({ acted: false, through: 2 });
  });

  test("a replayed event from before the mount never brings the tab back", () => {
    // The journal replays from zero on every load; a Browser tab the person
    // closed last week must stay closed.
    expect(agentBrowserActivity([browsed(1, 100, 3)], 150, 0)).toEqual({ acted: false, through: 0 });
  });

  test("a browser with no pages is not a reason to show one", () => {
    expect(agentBrowserActivity([browsed(4, 200, 0)], 150, 0)).toEqual({ acted: false, through: 4 });
  });

  test("a browser call the agent completed counts even when no state report followed", () => {
    // The state report is best effort; the call's own row is always journalled.
    const call = (id: number, status: string) =>
      ({ id, at: 200, type: "item.completed", item: { id: `i${id}`, status, detail: { type: "browser_action", call: { name: "mcp__telar__browser_navigate" } } } }) as unknown as EngineEvent;
    expect(agentBrowserActivity([call(6, "completed")], 150, 0)).toEqual({ acted: true, through: 6 });
    // A refused call — the person closed the browser — must not bring the tab back.
    expect(agentBrowserActivity([call(7, "failed")], 150, 0)).toEqual({ acted: false, through: 7 });
  });

  test("an agent's browse adds the Browser tab without changing the active tab", () => {
    const call = { id: 8, at: 200, type: "item.completed", item: { id: "i8", status: "completed", detail: { type: "browser_action", call: { name: "mcp__telar__browser_snapshot" } } } } as unknown as EngineEvent;
    expect(agentBrowserActivity([call], 150, 0).acted).toBe(true);
    const state: PanelTabState<string> = { tabs: [{ id: "diff", kind: "diff", params: {} }], activeTab: "diff", open: true };
    const next = revealPanelTab(state, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} });
    expect(next.tabs.map((tab) => tab.id)).toEqual(["diff", LIVE_BROWSER_TAB]);
    expect(next.activeTab).toBe("diff");
    expect(next.open).toBe(true);
  });

  test("ignores everything that is not the browser", () => {
    const other = { id: 5, at: 200, type: "display.opened", path: "a.md" } as unknown as EngineEvent;
    expect(agentBrowserActivity([other], 150, 0)).toEqual({ acted: false, through: 0 });
  });
});

describe("browserScopeToRelease", () => {
  test("the first Browser tab releases the bare session scope the agent drives", () => {
    expect(browserScopeToRelease("s1", { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} })).toBe("s1");
  });

  test("a second Browser releases its own scope, not the agent's", () => {
    const id = `${LIVE_BROWSER_TAB}#2`;
    expect(browserScopeToRelease("s1", { id, kind: LIVE_BROWSER_TAB, params: {} })).toBe(`s1#${id}`);
  });

  test("any other tab releases nothing", () => {
    expect(browserScopeToRelease("s1", { id: "diff", kind: "diff", params: {} })).toBeUndefined();
    expect(browserScopeToRelease("s1", undefined)).toBeUndefined();
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

describe("splitRoster", () => {
  test("agents on one side, background work on the other", () => {
    const split = splitRoster([
      { id: "shell", kind: "background", state: "running", items: [] },
      { id: "plain", kind: "agent", state: "running", items: [] },
    ] as never);
    expect(split.agents.map((task) => task.id)).toEqual(["plain"]);
    expect(split.processes.map((task) => task.id)).toEqual(["shell"]);
  });

  test("a task with no kind at all is presumed an agent, matching the contract's denylist", () => {
    const split = splitRoster([{ id: "unkinded", state: "running", items: [] }] as never);
    expect(split.agents).toHaveLength(1);
    expect(split.processes).toHaveLength(0);
  });

  test("the split has no third side, and no task lands on two", () => {
    // A container row would make a four-agent fan-out read as five running.
    const tasks = [
      { id: "shell", kind: "background", state: "running", items: [] },
      { id: "plain", kind: "agent", state: "running", items: [] },
      { id: "unkinded", state: "running", items: [] },
    ];
    const split = splitRoster(tasks as never);
    expect(Object.keys(split).sort()).toEqual(["agents", "processes"]);
    expect(split.agents.length + split.processes.length).toBe(tasks.length);
  });
});

describe("describeBrowserStart", () => {
  test("a tab means the press worked and the button goes quiet", () => {
    expect(describeBrowserStart({ running: true, tabs: [{ id: "0", url: "about:blank", title: "", active: true }] })).toEqual({ status: "idle" });
  });

  test("the engine's error is the message, verbatim", () => {
    expect(describeBrowserStart({ running: true, tabs: [], error: "Tab limit reached." })).toEqual({ status: "error", message: "Tab limit reached." });
  });

  test("running with no tab is named, not left looking like 'still starting'", () => {
    expect(describeBrowserStart({ running: true, tabs: [] })).toEqual({ status: "error", message: "The browser started but opened no page." });
    expect(describeBrowserStart({ running: false, tabs: [] })).toEqual({ status: "error", message: "The browser did not start." });
  });
});

describe("tabBadge", () => {
  const roster = splitRoster([
    { id: "a", kind: "agent", state: "running", items: [] },
    { id: "b", kind: "agent", state: "failed", items: [] },
    { id: "c", kind: "background", state: "completed", items: [] },
  ] as never);

  test("counts each side, with its running and failed tallies", () => {
    expect(tabBadge("agents", roster)).toEqual({ count: 2, running: 1, failed: 1 });
    expect(tabBadge("processes", roster)).toEqual({ count: 1, running: 0, failed: 0 });
  });

  test("any other kind, or an empty side, wears no badge", () => {
    expect(tabBadge("diff", roster)).toBeUndefined();
    expect(tabBadge("processes", splitRoster([]))).toBeUndefined();
  });
});
