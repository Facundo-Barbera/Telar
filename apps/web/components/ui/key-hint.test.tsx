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
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { restoreDefaultKeymap, setChord } from "@/lib/commands";
import { KeyHint, KeyHintOverlay } from "./key-hint";

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

/** Hold the command modifier over the page, or let it go. */
async function hold(down: boolean) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { key: "Meta", metaKey: down, bubbles: true }));
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

/**
 * EVERY CONTROL THE ISSUE NAMES ACTUALLY CARRIES ONE. Pinned against source
 * because these are call sites in four files that render inside a router, a
 * sidebar provider and a desktop bridge — the claim is "the hint is wired
 * there", and a harness that approximated those would be testing itself.
 */
describe("the call sites #401 lists", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("the rail: its search field, its collapse trigger, and its first nine rows", () => {
    const sidebar = read("../app-sidebar.tsx");
    expect(sidebar).toContain('<KeyHint command="search-sessions" always />');
    expect(sidebar).toContain('<KeyHint command="toggle-rail" />');
    // The numbers come off the same array the keys are handed — see
    // `railJumpSlots` and lib/command-keys.test.ts.
    expect(sidebar).toContain("const jumpSlots = railJumpSlots(jumpRows, jumpAgentEntry);");
    expect(sidebar).toContain("useCommandKeys(jumpRows, {");
    expect(read("../session/session-row.tsx")).toContain("<KeyHintOverlay command={`jump-${jumpSlot}`}>");
  });

  test("the Agent's row, which holds ⌘1 when the rail draws it (#569)", () => {
    // The one always-present entry in the rail had no number at all, because
    // the jumps skipped it and landed on the first conversation instead.
    expect(read("../session/agent-entry.tsx")).toContain("<KeyHintOverlay command={`jump-${jumpSlot}`}>");
    // …and the one fact that decides both the badges and the keys is read once
    // in the rail and handed to both, or ⌘2 lands on the row wearing ⌘1.
    expect(read("../app-sidebar.tsx")).toContain("useCommandKeys(jumpRows, {");
    expect(read("../app-sidebar.tsx")).toContain("}, jumpAgentHref);");
  });

  test("the Open menu's reveal row, which is the row ⌘O acts on", () => {
    expect(read("../session/open-workspace-button.tsx")).toContain('entry.kind === "reveal" && canReveal && <KeyHint command="reveal-in-finder" />');
  });

  test("the panel's tab strip: both arrows and the toggle", () => {
    const panel = read("../right-panel.tsx");
    expect(panel).toContain('<KeyHint command="panel-previous-tab" />');
    expect(panel).toContain('<KeyHint command="panel-next-tab" />');
    expect(panel).toContain('<KeyHint command="toggle-panel" />');
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
