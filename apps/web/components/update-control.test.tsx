/**
 * ONE CONTROL, TWO SURFACES — the sidebar footer and Settings ▸ Updates, mounted
 * side by side against the same scripted bridge and asserted to agree.
 *
 * WHY THE TWO ARE TESTED TOGETHER. The complaint in #389 is not that either
 * drew the wrong glyph; it is that they drew DIFFERENT ones, and that the idle
 * button's download arrow meant "download" in the one state where nothing is
 * downloading. A test of either alone could not have caught that. So each
 * state is pushed once and both surfaces are read for the same answer — which
 * is also why both wrap their control in `[data-slot=update-control]`.
 *
 * A DOM, because this is about what a push does to a mounted tree: the statuses
 * arrive over the bridge exactly as the shell broadcasts them, and the toast
 * appears and leaves on its own clock. `next/link` and `next/navigation` are
 * stubbed — mounting a router to read an `aria-label` off an anchor would be a
 * framework standing in for two strings.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UpdatePrefsInfo, UpdateStatus, UpdatesBridge } from "@/lib/desktop-updates";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("next/link", () => ({
  __esModule: true,
  // `prefetch` and friends are Next's routing knobs, and this stub does no
  // routing — passed through they would land on the DOM as attributes React
  // warns about. Dropped, exactly as the sidebar-footer fixture's stub does.
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => {
    const anchor = { ...rest };
    for (const knob of ["prefetch", "replace", "scroll"]) delete anchor[knob];
    return (
      <a href={href} {...anchor}>
        {children}
      </a>
    );
  },
}));

// ── the scripted shell, seated before the surfaces are imported ───────────
const listeners = new Set<(status: UpdateStatus) => void>();
const installs: number[] = [];

const bridge: UpdatesBridge = {
  check: async () => ({ status: "checking" }),
  install: async () => {
    installs.push(Date.now());
    return { status: "restarting" };
  },
  onStatus: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  status: async () => null,
  getPrefs: async () => ({ channel: "beta", installOnQuit: false, channels: ["beta"], configured: true, logPath: "/dev/null" }) as UpdatePrefsInfo,
  setPrefs: async () => ({ channel: "beta", installOnQuit: false }),
};
(globalThis as { window: { telarDesktop?: unknown } }).window.telarDesktop = { updates: bridge };

const { AppSidebarFooterRow } = await import("./app-sidebar-footer");
const { UpdatesSection } = await import("./settings/updates-section");

// The restart question asks the engine what is running, and Settings reads the
// session defaults; nothing is running and nothing is set here.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ sessions: [], projects: [], sessionDefaults: { envMode: "local" } })) as unknown as typeof fetch;

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

/** The lucide class each of the four states must draw, in BOTH surfaces. */
const GLYPH = {
  check: "lucide-refresh-cw",
  download: "lucide-download",
  apply: "lucide-power",
  spinner: "lucide-loader-circle",
} as const;

/** Poll a condition the way a person watches for one, inside `act` so React's
 *  own work is flushed between looks. */
// 15 s, the bound the engine suite's `eventually`/`until` helpers carry, under
// the 20 s bunfig ceiling: the caller waits for a toast it expects to dismiss
// itself, so a healthy run leaves on the first passing poll and only a loaded
// runner ever spends the budget (#458).
async function waitFor(done: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the toast to dismiss itself");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  }
}

type Surface = { host: HTMLElement; unmount: () => void };

function mountSurface(element: React.ReactElement): Surface {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Both surfaces, live, plus the push that drives them. */
function mountBoth() {
  const footer = mountSurface(<AppSidebarFooterRow onNavigate={() => {}} />);
  const settings = mountSurface(<UpdatesSection />);
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return {
    footer,
    settings,
    settle,
    push: async (status: UpdateStatus) => {
      await act(async () => {
        for (const listener of listeners) listener(status);
      });
    },
    /** The glyph each surface currently draws, as its lucide class. */
    glyphs: () =>
      [footer.host, settings.host].map((host) => host.querySelector('[data-slot="update-control"] svg')?.getAttribute("class") ?? "(none)"),
    toasts: () => [footer.host, settings.host].map((host) => host.querySelector('[data-slot="update-toast"]')?.textContent ?? null),
    unmount: () => {
      footer.unmount();
      settings.unmount();
    },
  };
}

beforeEach(() => {
  listeners.clear();
  installs.length = 0;
});

describe("the footer row", () => {
  test("Settings comes before Usage", async () => {
    // The user's own ordering (#389): Settings is the one they reach for,
    // Usage is the one they look at.
    const footer = mountSurface(<AppSidebarFooterRow onNavigate={() => {}} />);
    const labels = [...footer.host.querySelectorAll("a")].map((link) => link.getAttribute("aria-label"));
    expect(labels).toEqual(["Settings", "Usage"]);
    footer.unmount();
  });

  test("the update control stays at the right-hand end", async () => {
    const footer = mountSurface(<AppSidebarFooterRow onNavigate={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    const row = footer.host.firstElementChild!;
    expect(row.lastElementChild?.getAttribute("data-slot")).toBe("update-control");
    footer.unmount();
  });
});

describe("three states, the same glyph in both surfaces", () => {
  test("idle draws the arrow-circle — the CHECK glyph, not a download arrow", async () => {
    // The complaint the issue opens with: an idle button drawing a download
    // arrow reads as "download" in the one state where nothing is downloading.
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "not-available" });
    for (const glyph of both.glyphs()) expect(glyph).toContain(GLYPH.check);
    for (const glyph of both.glyphs()) expect(glyph).not.toContain(GLYPH.download);
    both.unmount();
  });

  test("a download in flight shows how far along it is: a ring in the rail, the glyph and words in Settings", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "downloading", version: "0.3.1", percent: 37 });
    // The rail's slot is too small for a glyph AND a number, so it is a ring
    // with the number inside it.
    const ring = both.footer.host.querySelector('[data-slot="update-control"] [role="progressbar"]');
    expect(ring?.getAttribute("aria-valuenow")).toBe("37");
    expect(both.settings.host.querySelector("svg")?.getAttribute("class")).toContain(GLYPH.download);
    // The percentage is on screen in both, because it is the only thing that
    // distinguishes a download from a hang.
    expect(both.footer.host.textContent).toContain("37");
    expect(both.settings.host.textContent).toContain("37%");
    // And it cannot be pressed: the update is already arriving.
    expect(both.footer.host.querySelector('[data-slot="update-control"] button')?.hasAttribute("disabled")).toBe(true);
    both.unmount();
  });

  test("a downloaded update draws the apply glyph, on the primary colour", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "downloaded", version: "0.3.1" });
    for (const glyph of both.glyphs()) expect(glyph).toContain(GLYPH.apply);
    const button = both.footer.host.querySelector('[data-slot="update-control"] button')!;
    expect(button.getAttribute("class")).toContain("text-primary");
    expect(button.getAttribute("aria-label")).toBe("Install v0.3.1 and restart");
    both.unmount();
  });

  test("a failed check keeps the check glyph and says what went wrong", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "error", message: "feed unreachable" });
    for (const glyph of both.glyphs()) expect(glyph).toContain(GLYPH.check);
    expect(both.footer.host.querySelector('[data-slot="update-control"] button')?.getAttribute("aria-label")).toContain("feed unreachable");
    expect(both.settings.host.textContent).toContain("feed unreachable");
    both.unmount();
  });

  test("restarting spins instead of stalling, and refuses the press", async () => {
    // The stall #389 reports: the app sat there looking pressable, so people
    // pressed again and got a native warning.
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "restarting", version: "0.3.1" });
    for (const glyph of both.glyphs()) expect(glyph).toContain(GLYPH.spinner);
    for (const host of [both.footer.host, both.settings.host]) {
      expect(host.querySelector('[data-slot="update-control"] button')?.hasAttribute("disabled")).toBe(true);
    }
    expect(both.settings.host.textContent).toContain("Restarting");
    both.unmount();
  });
});

describe("pressing apply", () => {
  test("one press, one install, and both surfaces switch to restarting", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "downloaded", version: "0.3.1" });
    const button = both.footer.host.querySelector('[data-slot="update-control"] button') as HTMLButtonElement;
    await act(async () => button.click());
    // Asked first: nothing installs until "Restart and update" is pressed.
    expect(installs).toHaveLength(0);
    const confirm = [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Restart and update")!;
    await act(async () => confirm.click());
    expect(installs).toHaveLength(1);
    expect(both.footer.host.querySelector('[data-slot="update-control"] svg')?.getAttribute("class")).toContain(GLYPH.spinner);
    // The OTHER surface learns from the shell's broadcast, not from this press.
    await both.push({ status: "restarting", version: "0.3.1" });
    expect(both.settings.host.textContent).toContain("Restarting");
    both.unmount();
  });
});

describe("the toast", () => {
  test("it appears above the control for news that arrived unasked", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "available", version: "0.3.1" });
    for (const toast of both.toasts()) expect(toast).toContain("0.3.1 is available");
    await both.push({ status: "downloaded", version: "0.3.1" });
    for (const toast of both.toasts()) expect(toast).toContain("restart to install");
    await both.push({ status: "restarting", version: "0.3.1" });
    for (const toast of both.toasts()) expect(toast).toContain("Restarting to install");
    // ANCHORED, not cornered: it hangs off the control it explains.
    const toast = both.footer.host.querySelector('[data-slot="update-toast"]')!;
    expect(toast.getAttribute("class")).toContain("absolute");
    expect(toast.getAttribute("class")).toContain("bottom-full");
    expect(toast.parentElement?.getAttribute("data-slot")).toBe("update-control");
    both.unmount();
  });

  test("an answer to a press the reader just made is not news", async () => {
    // `checking` and `not-available` are already on the control that was
    // pressed; a toast for them announces that you did the thing you just did.
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "checking" });
    expect(both.toasts()).toEqual([null, null]);
    await both.push({ status: "not-available" });
    expect(both.toasts()).toEqual([null, null]);
    both.unmount();
  });

  test("it dismisses itself and does not come back for the same news", async () => {
    const both = mountBoth();
    await both.settle();
    await both.push({ status: "downloaded", version: "0.3.1" });
    expect(both.toasts()[0]).toContain("restart to install");
    // WAITED FOR, NOT SLEPT THROUGH. The dismissal is on a four-second real
    // clock; polling for it asserts the same thing without pinning the suite to
    // a machine's spare capacity.
    await waitFor(() => both.toasts().every((toast) => toast === null));
    expect(both.toasts()).toEqual([null, null]);
    await both.push({ status: "downloaded", version: "0.3.1" });
    expect(both.toasts()).toEqual([null, null]);
    // A NEW version is new news.
    await both.push({ status: "downloaded", version: "0.3.2" });
    for (const toast of both.toasts()) expect(toast).toContain("0.3.2");
    both.unmount();
  });
});
