/**
 * THE SIDEBAR'S UPDATE CONTROL: a restart to update asks first, and a download
 * shows its progress as a ring.
 *
 * Mounted for real against a fake shell bridge, because the question is about
 * what a PRESS does — install straight away, or ask — and a unit test of the
 * copy alone would pass with the button still wired to install.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UpdateStatus } from "@/lib/desktop-updates";

GlobalRegistrator.register({ url: "http://localhost/sessions" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(),
}));

const { AppSidebarFooterRow } = await import("./app-sidebar-footer");
const { restartDialogCopy, countWorkingSessions } = await import("@/lib/desktop-updates");
const { ProgressRing } = await import("@/components/ui/progress-ring");

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let installs = 0;
let busyAsked = 0;
let listeners: ((status: UpdateStatus) => void)[] = [];
let sessionDefaults = { envMode: "local", resumeAfterRestart: false };
let defaultsPatches: unknown[] = [];

function shell(status: UpdateStatus, terminals = { count: 0, commands: [] as string[] }) {
  (window as unknown as { telarDesktop: unknown }).telarDesktop = {
    updates: {
      check: async () => ({ status: "checking" }),
      install: async () => {
        installs += 1;
        return { status: "restarting" };
      },
      busy: async () => {
        busyAsked += 1;
        return { terminals };
      },
      onStatus: (listener: (status: UpdateStatus) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      status: async () => status,
      getPrefs: async () => ({ channel: "beta", channels: ["beta"], installOnQuit: false, configured: true }),
      setPrefs: async (patch: unknown) => patch,
    },
  };
}

function engine(activities: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/sessions/live")) {
      return Response.json({ sessions: activities.map((activity, index) => ({ id: `session_${index}`, activity })), projects: [] });
    }
    if (url.includes("/api/session-defaults")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        defaultsPatches.push(patch);
        sessionDefaults = { ...sessionDefaults, ...patch };
      }
      return Response.json({ sessionDefaults });
    }
    return Response.json({});
  }) as typeof fetch;
}

beforeEach(() => {
  installs = 0;
  busyAsked = 0;
  listeners = [];
  sessionDefaults = { envMode: "local", resumeAfterRestart: false };
  defaultsPatches = [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function settle() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AppSidebarFooterRow onNavigate={() => undefined} />));
  await settle();
}

const updateButton = () => host!.querySelector<HTMLButtonElement>('[data-slot="update-control"] button')!;
const dialog = () => document.body.querySelector('[data-slot="dialog-content"]');
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);

describe("Install & restart asks first", () => {
  test("the press opens the dialog instead of installing", async () => {
    shell({ status: "downloaded", version: "1.2.3" });
    engine(["working", "idle"]);
    await mount();
    await act(async () => updateButton().click());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Restart to update?");
    expect(dialog()!.textContent).toContain("One session is working. It will stop until Telar reopens.");
    expect(installs).toBe(0);
  });

  test("Cancel does nothing", async () => {
    shell({ status: "downloaded", version: "1.2.3" });
    engine([]);
    await mount();
    await act(async () => updateButton().click());
    await settle();
    await act(async () => button("Cancel")!.click());
    await settle();
    expect(installs).toBe(0);
    expect(dialog()).toBeNull();
  });

  test("Restart and update proceeds, once", async () => {
    shell({ status: "downloaded", version: "1.2.3" });
    engine([]);
    await mount();
    await act(async () => updateButton().click());
    await settle();
    expect(dialog()!.textContent).toContain("Nothing is running right now.");
    await act(async () => button("Restart and update")!.click());
    await settle();
    expect(installs).toBe(1);
  });

  test("busy terminals are folded into the same dialog, so the shell asks nothing more", async () => {
    shell({ status: "downloaded", version: "1.2.3" }, { count: 2, commands: ["bun run dev", "tail -f log"] });
    engine(["working", "monitoring"]);
    await mount();
    await act(async () => updateButton().click());
    await settle();
    expect(busyAsked).toBe(1);
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("2 sessions are working.");
    expect(text).toContain("2 terminals are running commands, which will be ended:");
    expect(text).toContain("bun run dev");
    // One dialog, and the install path in the shell never asks its own — see
    // apps/desktop/update-install.test.js.
    expect(document.body.querySelectorAll('[data-slot="dialog-content"]').length).toBe(1);
  });

  test("the checkbox writes the General setting", async () => {
    shell({ status: "downloaded", version: "1.2.3" });
    engine([]);
    await mount();
    await act(async () => updateButton().click());
    await settle();
    const box = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    await act(async () => box.click());
    await settle();
    expect(defaultsPatches).toEqual([{ resumeAfterRestart: true }]);
    expect(box.checked).toBe(true);
    expect(installs).toBe(0);
  });
});

describe("the download's progress ring", () => {
  test("shows the percentage inside, as a progressbar", async () => {
    shell({ status: "downloading", version: "1.2.3", percent: 41.6 });
    engine([]);
    await mount();
    const ring = host!.querySelector('[role="progressbar"]')!;
    expect(ring.getAttribute("aria-valuenow")).toBe("42");
    expect(ring.getAttribute("aria-valuemin")).toBe("0");
    expect(ring.getAttribute("aria-valuemax")).toBe("100");
    expect(ring.textContent).toBe("42");
  });

  test("a finished download goes back to the ready glyph", async () => {
    shell({ status: "downloading", version: "1.2.3", percent: 99 });
    engine([]);
    await mount();
    await act(async () => listeners.forEach((listener) => listener({ status: "downloaded", version: "1.2.3" })));
    await settle();
    expect(host!.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("the arc does not animate under reduced motion, and is clamped", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ProgressRing percent={140} label="x" />));
    const arc = host.querySelectorAll("circle")[1]!;
    expect(arc.getAttribute("class")).toContain("motion-reduce:transition-none");
    expect(host.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
  });
});

test("the copy and the count", () => {
  expect(countWorkingSessions([{ activity: "working" }, { activity: "monitoring" }, { activity: "idle" }, { activity: "queued" }])).toBe(2);
  expect(restartDialogCopy(undefined).terminals).toBeUndefined();
  expect(restartDialogCopy({ workingSessions: 0, busyTerminals: 1, commands: ["make"] })).toEqual({
    description: "Telar closes and reopens on the new version. Nothing is running right now.",
    terminals: "One terminal is running a command, which will be ended:",
    commands: ["make"],
  });
});
