import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorktreeInventory, WorktreeLocation, WorktreeSummary } from "@telar/engine-client";
import { WorktreeSummarySection } from "./worktree-summary-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const GB = 1024 ** 3;
const tally = (count: number, gb: number) => ({ count, bytes: gb * GB, unmeasured: 0 });

const CURRENT: WorktreeLocation = { folder: "/Volumes/Taller/worktrees", label: "Taller", volume: "Taller", present: true, current: true, worktrees: tally(8, 3) };
const OLD: WorktreeLocation = {
  folder: "/Volumes/Focaltec HD/live/Telar",
  label: "Focaltec HD",
  volume: "Focaltec HD",
  present: true,
  current: false,
  worktrees: tally(150, 40),
  move: { movable: tally(143, 38), staying: { busy: 1, dirty: 5, unowned: 1, detached: 0 } },
};

function summaryWith(locations: WorktreeLocation[]): WorktreeSummary {
  return {
    locations,
    states: [
      { state: "in-use", worktrees: tally(6, 2), releasable: tally(0, 0) },
      { state: "archived", worktrees: tally(40, 10), releasable: tally(38, 9) },
      { state: "orphaned", worktrees: tally(0, 0), releasable: tally(0, 0) },
      { state: "unchanged", worktrees: tally(10, 3), releasable: tally(10, 3) },
      { state: "idle", worktrees: tally(100, 26), releasable: tally(97, 24) },
      { state: "recent", worktrees: tally(2, 1), releasable: tally(0, 0) },
    ],
    idleDays: 14,
    checkedAt: Date.now() - 2 * 60_000,
    measuring: false,
    partial: false,
  };
}

let summary = summaryWith([CURRENT, OLD]);
let calls: { url: string; method: string; body?: unknown }[] = [];
const realFetch = globalThis.fetch;
const INVENTORY: WorktreeInventory = { rows: [], roots: [], partial: false, measuredAt: Date.now() };

beforeEach(() => {
  summary = summaryWith([CURRENT, OLD]);
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/worktrees/summary")) return Response.json({ summary });
    if (url === "/api/worktrees-root/move") {
      return Response.json({
        move: {
          moved: Array.from({ length: 143 }, (_, index) => ({ sessionId: `s${index}`, from: "/a", to: "/b" })),
          skipped: [
            { sessionId: "d", path: "/a/d", reason: "dirty" },
            { sessionId: "f", path: "/a/f", reason: "failed" },
          ],
          summary: "Moved 143 checkouts. 1 has uncommitted changes and stayed put — commit them and run this again.",
        },
      });
    }
    if (url === "/api/worktrees/reclaim") return Response.json({ reclaim: { results: [], summary: "Released 97 checkouts." } });
    if (url === "/api/worktrees") return Response.json({ inventory: INVENTORY });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<WorktreeSummarySection />);
    await settle();
  });
  await act(async () => {
    await settle();
  });
  const buttons = () => [...document.querySelectorAll("button")];
  return {
    host,
    text: () => host.textContent ?? "",
    button: (label: string) => buttons().find((candidate) => candidate.textContent?.trim() === label),
    buttonStarting: (prefix: string) => buttons().find((candidate) => candidate.textContent?.trim().startsWith(prefix)),
    click: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("Settings ▸ Storage ▸ where worktrees live", () => {
  test("each location is labelled and counted, the current one marked, with when it was checked; paths stay in tooltips", async () => {
    const view = await mount();
    expect(view.text()).toContain("Tallercurrent8 worktrees · 3.0 GB");
    expect(view.text()).toContain("Focaltec HD150 worktrees · 40 GB");
    expect(view.text()).toContain("Checked 2m ago.");
    expect(view.text()).not.toContain("/Volumes/");
    expect(view.host.querySelector('[title="/Volumes/Focaltec HD/live/Telar"]')?.textContent).toBe("Focaltec HD");
    view.unmount();
  });

  test("live file watchers are counted per location and for the whole Mac", async () => {
    summary = { ...summaryWith([{ ...CURRENT, fsmonitor: 0 }, { ...OLD, fsmonitor: 120 }]), fsmonitor: 131 };
    const view = await mount();
    expect(view.text()).toContain("Focaltec HD150 worktrees · 40 GB · 120 file watchers");
    expect(view.text()).not.toContain("3.0 GB · 0 file watchers");
    expect(view.text()).toContain("131 file watchers running on this Mac.");
    view.unmount();
  });

  test("the move button is short: count, size and the destination's label", async () => {
    const view = await mount();
    const button = view.button("Move 143 worktrees · 38 GB to Taller");
    expect(button?.getAttribute("title")).toBe("/Volumes/Focaltec HD/live/Telar → /Volumes/Taller/worktrees");
    view.unmount();
  });

  test("before moving it shows the full paths and how many stay put; afterwards the outcome in numbers", async () => {
    const view = await mount();
    await view.click(view.button("Move 143 worktrees · 38 GB to Taller")!);
    expect(view.text()).toContain("Move 143 worktrees from /Volumes/Focaltec HD/live/Telar to /Volumes/Taller/worktrees?");
    expect(view.text()).toContain("7 will stay put: 5 have uncommitted changes, 1 has a turn running, 1 belongs to no session.");
    expect(calls.some((call) => call.url === "/api/worktrees-root/move")).toBe(false);

    await view.click(view.button("Move them")!);
    expect(calls.find((call) => call.url === "/api/worktrees-root/move")?.body).toEqual({ from: "/Volumes/Focaltec HD/live/Telar" });
    expect(view.text()).toContain("Moved 143 · stayed 1 · failed 1");
    view.unmount();
  });

  test("with nothing movable there is no button, only a short line saying why", async () => {
    summary = summaryWith([CURRENT, { ...OLD, move: { movable: tally(0, 0), staying: { busy: 0, dirty: 2, unowned: 0, detached: 0 } } }]);
    const view = await mount();
    expect(view.buttonStarting("Move")).toBeUndefined();
    expect(view.text()).toContain("Nothing here can move. 2 will stay put: 2 have uncommitted changes.");
    view.unmount();
  });

  test("a drive that is not plugged in is shown as such, with no move button", async () => {
    summary = summaryWith([CURRENT, { ...OLD, present: false, move: undefined } as WorktreeLocation]);
    const view = await mount();
    expect(view.text()).toContain("not connected");
    expect(view.buttonStarting("Move")).toBeUndefined();
    expect(view.text()).toContain("Plug the drive in to move these.");
    view.unmount();
  });

  test("a volume the engine skipped because it was slow or gone is named once", async () => {
    summary = { ...summaryWith([CURRENT, OLD]), degradedVolumes: [{ mount: "/Volumes/Focaltec HD", state: "slow" }] };
    const view = await mount();
    expect(view.text()).toContain("Focaltec HD is slow or not connected.");
    view.unmount();
  });
});

describe("Settings ▸ Storage ▸ worktrees by state", () => {
  test("each state shows its count, and the cleanable ones say what a click would do", async () => {
    const view = await mount();
    expect(view.text()).toContain("Idle more than 14 days");
    expect(view.text()).toContain("100 worktrees · 26 GB");
    expect(view.button("Release 97 worktrees · 24 GB")).toBeDefined();
    expect(view.button("Release 38 worktrees · 9.0 GB")).toBeDefined();
    expect(view.buttonStarting("Release 0")).toBeUndefined();
    view.unmount();
  });

  test("a state with no worktrees is not drawn", async () => {
    const view = await mount();
    expect(view.text()).not.toContain("No session");
    expect(view.text()).toContain("Archived sessions");
    view.unmount();
  });

  test("with no worktrees at all, one line says so", async () => {
    summary = { ...summaryWith([{ ...CURRENT, worktrees: tally(0, 0) }]), states: summaryWith([]).states.map((entry) => ({ ...entry, worktrees: tally(0, 0), releasable: tally(0, 0) })) };
    const view = await mount();
    expect(view.text()).toContain("No worktrees in any state.");
    expect(view.text()).not.toContain("In use");
    expect(view.button("Show all (0)")?.hasAttribute("disabled")).toBe(true);
    view.unmount();
  });

  test("releasing asks once more, then sends only the state", async () => {
    const view = await mount();
    await view.click(view.button("Release 97 worktrees · 24 GB")!);
    expect(calls.some((call) => call.url === "/api/worktrees/reclaim")).toBe(false);
    await view.click(view.button("Confirm: Release 97 worktrees · 24 GB")!);
    expect(calls.find((call) => call.url === "/api/worktrees/reclaim")?.body).toEqual({ state: "idle" });
    expect(view.text()).toContain("Released 97 checkouts.");
    view.unmount();
  });
});

describe("the individual list", () => {
  test("is never on the page: it opens in a dialog, and only then is fetched", async () => {
    const view = await mount();
    expect(calls.some((call) => call.url === "/api/worktrees")).toBe(false);
    await view.click(view.button("Show all (158)")!);
    await act(async () => {
      await settle();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("All worktrees");
    expect(dialog?.querySelector('[aria-label="Search worktrees"]')).not.toBeNull();
    expect(view.host.contains(dialog)).toBe(false);
    expect(calls.some((call) => call.url === "/api/worktrees")).toBe(true);
    view.unmount();
  });
});
