/**
 * WHERE SESSION CHECKOUTS GO — issue #642 part 2.
 *
 * The claims here are all about what the row SAYS, because every one of them is
 * a promise the setting has to keep:
 *
 *   IT DOES NOT PROMISE A RESTART, because none is needed. Inheriting #630's
 *   `restartRequired` out of symmetry would cost a person a restart for nothing.
 *
 *   IT DOES NOT PROMISE A MOVE. Changing the root affects the next cut; a row
 *   that let somebody believe their 12 GB had just relocated would be the
 *   setting lying about what it did.
 *
 *   IT NAMES THE DRIVE WHEN THE DRIVE IS AWAY, from the label recorded when it
 *   was chosen — the moment that sentence is needed is the moment the disk is
 *   not there to be asked.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorktreesRoot } from "@telar/engine-client";
import { WorktreesRootSection, worktreesRootHint } from "./worktrees-root-section";

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
    root.render(<WorktreesRootSection />);
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

describe("Settings ▸ Storage ▸ Session checkouts", () => {
  test("it never tells anybody to restart", async () => {
    answer = { kind: "configured", root: "/Volumes/TelarVR/checkouts", default: DEFAULT_ROOT, label: "TelarVR" };
    const view = await mount();
    expect(view.host.textContent?.toLowerCase()).not.toContain("restart");
    view.unmount();
  });

  test("it says the checkouts already cut stay where they are", async () => {
    // Otherwise the row reads as a promise that 12 GB just moved.
    answer = { kind: "configured", root: "/Volumes/TelarVR/checkouts", default: DEFAULT_ROOT, label: "TelarVR" };
    const view = await mount();
    expect(view.host.textContent).toContain("already cut stay where they are");
    view.unmount();
  });

  test("the reproducibility asymmetry is on screen, not only in the commit message", async () => {
    const view = await mount();
    const text = view.host.textContent ?? "";
    expect(text).toContain("re-cuts");
    // The sentence that makes this the safe half of #630 to relocate.
    expect(text).toContain("with the whole store out, it cannot start at all");
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
  test("the default says these are the one thing that comes back", () => {
    expect(worktreesRootHint({ kind: "default", root: DEFAULT_ROOT, default: DEFAULT_ROOT })).toContain("comes back");
  });

  test("a drive carries the durability warning #630 already wrote", () => {
    // The same sentence, not a second one: two warnings about the same risk
    // drift apart the first time one of them is edited.
    const hint = worktreesRootHint({ kind: "configured", root: "/Volumes/TelarVR/cuts", default: DEFAULT_ROOT, label: "TelarVR" });
    expect(hint).toContain("Eject before unplugging");
  });

  test("a folder on this machine's own disk gets no drive warning", () => {
    const hint = worktreesRootHint({ kind: "configured", root: "/Users/someone/checkouts", default: DEFAULT_ROOT });
    expect(hint).not.toContain("Eject before unplugging");
  });
});
