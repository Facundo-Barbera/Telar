/**
 * THE CAPS A CONTROL WEARS — issue #401.
 *
 * WHAT HAS TO BE TRUE, and none of it is about styling: the caps come from the
 * LIVE keymap (a rebound chord shows the rebound keys, an unbound one shows
 * nothing at all), the held-gated form is absent until ⌘ is down, and the
 * `always` form — the search field's ⌘K, which was a hardcoded `<kbd>` before
 * this pass — draws without one.
 *
 * Rendered rather than asserted against source, because the interesting claim
 * is what a person sees for a given keymap, and the keymap is a store this
 * component reads through `useSyncExternalStore` rather than a prop.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { restoreDefaultKeymap, setChord } from "../commands";
import type { PanelTabItem } from "@/features/panel";
import type { SidebarSession } from "@/features/sessions";
import { KeyHint, KeyHintOverlay } from "./key-hint";

const navigation = await import("next/navigation");

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * UNMOUNTED BETWEEN TESTS, not merely detached. The held-modifier store is a
 * module store whose listeners come off with the LAST subscriber (which is what
 * resets it), so a root left mounted would carry a hold into the next test and
 * answer a keypress meant for nobody.
 */
const roots: Root[] = [];

beforeEach(() => {
  restoreDefaultKeymap();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

/** Mount a node and answer its host. The platform is read a tick after the
 *  first paint (see `useKeyCapPlatform`), so the timers are flushed before
 *  anything is read — otherwise every assertion would be against the "mac"
 *  default rather than against what this agent string resolves to. */
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
  return host;
}

/** Hold the command modifier over the page, or let it go. Both flags, because
 *  the held store caches the platform the first file in the process saw. */
async function hold(down: boolean) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { key: "Meta", metaKey: down, ctrlKey: down, bubbles: true }));
  });
}

const caps = (host: HTMLElement) => [...host.querySelectorAll("kbd")].map((cap) => cap.textContent);

describe("a held hint", () => {
  test("is absent until the modifier is down, and gone again on release", async () => {
    const host = await mount(<KeyHint command="toggle-rail" />);
    expect(caps(host)).toEqual([]);
    await hold(true);
    expect(caps(host)).toEqual(["⌘", "B"]);
    await hold(false);
    expect(caps(host)).toEqual([]);
  });

  test("it is hidden from assistive technology — the control's own name carries the chord", async () => {
    const host = await mount(<KeyHint command="toggle-rail" />);
    await hold(true);
    expect(host.querySelector("[data-slot=key-hint]")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the keymap is the source, never a literal", () => {
  test("a REBOUND chord shows the keys it was rebound to", async () => {
    setChord("toggle-rail", "CommandOrControl+Alt+B");
    const host = await mount(<KeyHint command="toggle-rail" />);
    await hold(true);
    expect(caps(host)).toEqual(["⌘", "⌥", "B"]);
  });

  test("an UNBOUND command draws nothing — a key that does nothing must not be promised", async () => {
    setChord("toggle-rail", "");
    const host = await mount(<KeyHint command="toggle-rail" />);
    await hold(true);
    expect(caps(host)).toEqual([]);
  });

  test("a rebind while the hint is on screen reaches it", async () => {
    const host = await mount(<KeyHint command="search-sessions" />);
    await hold(true);
    expect(caps(host)).toEqual(["⌘", "K"]);
    await act(async () => {
      setChord("search-sessions", "CommandOrControl+/");
    });
    expect(caps(host)).toEqual(["⌘", "/"]);
  });
});

describe("the always-on form", () => {
  test("draws with no modifier held — the search field's ⌘K, which was there before this pass", async () => {
    const host = await mount(<KeyHint command="search-sessions" always />);
    expect(caps(host)).toEqual(["⌘", "K"]);
  });

  test("and still says nothing when the command is unbound", async () => {
    setChord("search-sessions", "");
    const host = await mount(<KeyHint command="search-sessions" always />);
    expect(caps(host)).toEqual([]);
  });
});

describe("the call sites #401 lists", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => Response.json({}, { status: 404 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const installNavigation = () =>
    mock.module("next/navigation", () => ({
      ...navigation,
      usePathname: () => "/",
      useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      redirect: navigation.redirect,
    }));

  test("a rail row wears its jump number while the modifier is held", async () => {
    installNavigation();
    const { SessionRow } = await import("@/features/sessions/rail/session-row");
    const { SidebarProvider } = await import("@/ui/sidebar");
    const session = { id: "session_1", title: "Exoplanets", projectId: "p1", activity: "idle", createdAt: 1, updatedAt: 1 } as SidebarSession;
    const host = await mount(
      <SidebarProvider>
        <SessionRow session={session} active={false} showProject={false} variant="card" jumpSlot={1} renderedAt={1} onRowChanged={() => {}} />
      </SidebarProvider>,
    );
    expect(caps(host)).toEqual([]);
    await hold(true);
    expect(caps(host)).toEqual(["⌘", "1"]);
  });

  test("the Open menu's reveal row, which is the row ⌘O acts on", async () => {
    const bridge = {
      openers: async () => ({ openers: [] }),
      open: async () => ({ ok: true }),
      reveal: async () => ({ ok: true }),
    };
    (window as { telarDesktop?: unknown }).telarDesktop = { workspace: bridge };
    try {
      const { OpenWorkspaceButton } = await import("@/features/files/components/open-workspace-button");
      const host = await mount(<OpenWorkspaceButton path="/work/telar" />);
      await act(async () => (host.querySelector('[aria-label="Choose an app to open this folder with"]') as HTMLElement).click());
      await hold(true);
      const reveal = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Reveal in Finder"));
      expect(caps(reveal as HTMLElement)).toEqual(["⌘", "O"]);
    } finally {
      delete (window as { telarDesktop?: unknown }).telarDesktop;
    }
  });

  test("the panel's tab strip: both arrows while there is a tab to step to, and the toggle always", async () => {
    const { RightPanel } = await import("@/features/panel");
    const panel = (tabs: PanelTabItem[]) =>
      mount(
        <RightPanel sessionId="session_a" tabs={tabs} tab={tabs[0]!.id} onTabChange={() => {}} onOpenTab={() => {}} onCloseTab={() => {}} onClose={() => {}} />,
      );
    const hints = (host: HTMLElement) => host.querySelectorAll("[data-slot=key-hint]").length;
    const one = await panel([{ id: "agents", kind: "agents", params: {} } as PanelTabItem]);
    const two = await panel([{ id: "agents", kind: "agents", params: {} } as PanelTabItem, { id: "processes", kind: "processes", params: {} } as PanelTabItem]);
    await hold(true);
    expect(hints(one)).toBe(1);
    expect(hints(two)).toBe(3);
  });
});

describe("the overlay", () => {
  test("keeps what is under it mounted and dims it, so nothing moves", async () => {
    const host = await mount(
      <KeyHintOverlay command="toggle-rail">
        <span data-testid="under">8h ago</span>
      </KeyHintOverlay>,
    );
    const under = () => host.querySelector("[data-testid=under]")!.parentElement!;
    expect(under().className).not.toContain("opacity-20");
    await hold(true);
    // Still in the document — the row's own width is what must not change.
    expect(host.querySelector("[data-testid=under]")?.textContent).toBe("8h ago");
    expect(under().className).toContain("opacity-20");
    expect(caps(host)).toEqual(["⌘", "B"]);
  });

  test("an unbound command dims nothing: there would be nothing to reveal", async () => {
    setChord("toggle-rail", "");
    const host = await mount(
      <KeyHintOverlay command="toggle-rail">
        <span data-testid="under">8h ago</span>
      </KeyHintOverlay>,
    );
    await hold(true);
    expect(host.querySelector("[data-testid=under]")!.parentElement!.className).not.toContain("opacity-20");
    expect(caps(host)).toEqual([]);
  });
});
