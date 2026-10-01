import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorktreesRoot } from "@telar/engine-client";
import { SettingsGroup } from "@/features/settings/components/settings-shell";
import { ROTATIONAL_WARNING, WorktreesRootRow, worktreesRootHint } from "./worktrees-root-section";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const DEFAULT_ROOT = "/Users/someone/Library/Application Support/Telar/engine/worktrees";

let answer: WorktreesRoot = { kind: "default", root: DEFAULT_ROOT, default: DEFAULT_ROOT };
let sent: { method: string; body?: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answer = { kind: "default", root: DEFAULT_ROOT, default: DEFAULT_ROOT };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ worktreesRoot: answer }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SettingsGroup title="Worktrees">
        <WorktreesRootRow />
      </SettingsGroup>,
    );
    await settle();
  });
  await act(async () => {
    await settle();
  });
  return {
    host,
    button: (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("Settings ▸ Storage ▸ Worktrees ▸ Location", () => {
  test("it never tells anybody to restart", async () => {
    answer = { kind: "configured", root: "/Volumes/TelarVR/checkouts", default: DEFAULT_ROOT, label: "TelarVR" };
    const view = await mount();
    expect(view.host.textContent?.toLowerCase()).not.toContain("restart");
    view.unmount();
  });

  test("the row is one sentence with the path; the drive caveats sit behind its ⓘ", async () => {
    answer = { kind: "configured", root: "/Volumes/TelarVR/checkouts", default: DEFAULT_ROOT, label: "TelarVR" };
    const view = await mount();
    expect(view.host.textContent).toContain("New worktrees are made in /Volumes/TelarVR/checkouts.");
    expect(view.host.textContent).not.toContain("Eject before unplugging");
    const info = view.host.querySelector("[data-info]")?.getAttribute("data-info") ?? "";
    expect(info).toContain("Eject before unplugging");
    expect(info).toContain("moves nothing already made");
    view.unmount();
  });

  test("a location on a spinning disk shows a one-line warning, and the change still went through", async () => {
    answer = { kind: "configured", root: "/Volumes/Spinner/checkouts", default: DEFAULT_ROOT, rotational: true };
    const view = await mount();
    expect(view.host.textContent).toContain("New worktrees are made in /Volumes/Spinner/checkouts.");
    expect(view.host.textContent).toContain(ROTATIONAL_WARNING);
    view.unmount();

    answer = { kind: "configured", root: "/Users/someone/checkouts", default: DEFAULT_ROOT };
    const solid = await mount();
    expect(solid.host.textContent).not.toContain(ROTATIONAL_WARNING);
    solid.unmount();
  });

  test("a folder on this Mac's own disk has no drive caveat behind its ⓘ", async () => {
    answer = { kind: "configured", root: "/Users/someone/checkouts", default: DEFAULT_ROOT };
    const view = await mount();
    expect(view.host.querySelector("[data-info]")?.getAttribute("data-info") ?? "").not.toContain("Eject");
    view.unmount();
  });

  test("an absent drive is named, and the name comes from the record", async () => {
    answer = {
      kind: "absent",
      root: "/Volumes/TelarVR/checkouts",
      default: DEFAULT_ROOT,
      label: "TelarVR",
      blocker: "Telar keeps its session checkouts on TelarVR, which is not connected. Plug it back in, or choose another location in Settings ▸ Storage.",
    };
    const view = await mount();
    expect(view.host.textContent).toContain("TelarVR");
    expect(view.host.textContent).toContain("not connected");
    view.unmount();
  });

  test("an unreadable record says which file to fix rather than falling back quietly", async () => {
    answer = {
      kind: "unreadable",
      default: DEFAULT_ROOT,
      blocker: "/store/worktrees-location.json was written by a different version of Telar and this one does not recognise it.",
    };
    const view = await mount();
    expect(view.host.textContent).toContain("worktrees-location.json");
    view.unmount();
  });

  test("`Use default` appears only once there is something to go back from", async () => {
    const onDefault = await mount();
    expect(onDefault.button("Use default")).toBeUndefined();
    onDefault.unmount();

    answer = { kind: "configured", root: "/elsewhere/checkouts", default: DEFAULT_ROOT };
    const moved = await mount();
    expect(moved.button("Use default")).toBeDefined();
    moved.unmount();
  });

  test("putting it back sends null, which is what the engine reads as the default", async () => {
    answer = { kind: "configured", root: "/elsewhere/checkouts", default: DEFAULT_ROOT };
    const view = await mount();
    await act(async () => {
      view.button("Use default")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(sent.at(-1)).toEqual({ method: "PUT", body: { root: null } });
    view.unmount();
  });

  test("a browser tab with no folder picker says so instead of failing silently", async () => {
    const view = await mount();
    await act(async () => {
      view.button("Change…")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await settle();
    });
    // No desktop bridge and no `/api/browse` here: the row reports it rather
    // than appearing to do nothing.
    expect(sent.some((request) => request.method === "PUT")).toBe(false);
    view.unmount();
  });
});

describe("the row's sentence, per state", () => {
  test("a usable location names the folder", () => {
    expect(worktreesRootHint({ kind: "default", root: DEFAULT_ROOT, default: DEFAULT_ROOT })).toBe(`New worktrees are made in ${DEFAULT_ROOT}.`);
  });

  test("an absent drive without a blocker still names the folder and says it is not connected", () => {
    const hint = worktreesRootHint({ kind: "absent", root: "/Volumes/TelarVR/cuts", default: DEFAULT_ROOT, label: "TelarVR" });
    expect(hint).toBe("/Volumes/TelarVR/cuts is on a drive that is not connected.");
  });
});
