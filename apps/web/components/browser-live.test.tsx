/**
 * THE BROWSER'S `⋯` MENU AND ITS DEVICE TOOLBAR (#473).
 *
 * WHY THIS FILE MOUNTS AND CLICKS where `browser-live.test.ts` beside it is
 * arithmetic and a source scan: what this issue changed is WHICH CONTROLS
 * EXIST AND WHERE. A menu that stopped rendering a row, a toolbar that
 * appeared in fit mode, a toggle that sent the wrong mode — none of those are
 * visible to a pure function, and all of them are the bug.
 *
 * The DOM is registered for this file and handed back in `afterAll`, because
 * the suite shares one process and its neighbours are written for a world with
 * no `window` in it. That is late for one thing only — the UI primitives
 * freeze whether they have layout effects at their first import — and the
 * preload (scripts/test-dom.mjs) settles that before any test file loads.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  DesktopBrowserSurface,
  type DesktopBrowserBridge,
  type DesktopBrowserPanelState,
  type DesktopBrowserTab,
} from "./browser-live";
import { nativeViewOverlayHidden } from "@/lib/native-view-overlay";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (patch: Partial<DesktopBrowserTab> = {}): DesktopBrowserTab => ({
  index: 0,
  id: "tab_1",
  title: "Example",
  url: "https://example.com/",
  active: true,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoom: 1,
  colorScheme: "system",
  preview: false,
  viewport: { width: 1280, height: 800, preset: "default", mode: "fit" },
  ...patch,
});

const panelState = (patch: Partial<DesktopBrowserPanelState> = {}): DesktopBrowserPanelState => ({
  scopeKey: "session_a",
  tabs: [tab()],
  profile: { id: "bp_1", label: "Work", partition: "persist:telar-profile-bp_1" },
  profiles: [{ id: "bp_1", label: "Work", partition: "persist:telar-profile-bp_1" }],
  presentation: { width: 1280, height: 800, scale: 0.5, rect: { x: 0, y: 0, width: 640, height: 400 } },
  ...patch,
});

/** The bridge, recording what the panel asked the shell to do. */
function makeBridge(state: DesktopBrowserPanelState, extra: Partial<DesktopBrowserBridge> = {}) {
  const actions: Record<string, unknown>[] = [];
  const cleared: string[] = [];
  const visibility: boolean[] = [];
  const bridge: DesktopBrowserBridge = {
    getState: async () => state,
    action: async (_scope, action) => {
      actions.push(action);
      return state;
    },
    setBounds: async () => {},
    setVisible: async (_scope, visible) => {
      visibility.push(visible);
    },
    onState: () => () => {},
    setScopeProfile: async () => ({ profileId: "bp_1", partition: "persist:telar-profile-bp_1" }),
    clearBrowsingData: async (_scope, kind) => {
      cleared.push(kind);
      return { ok: true, kind, partition: "persist:telar-profile-bp_1" };
    },
    ...extra,
  };
  return { actions, bridge, cleared, visibility };
}

/** A quiet moment — long enough for a frame, when there are frames. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** A real mouse press: the events a browser sends, in order, on the deepest
 *  element under the pointer, held long enough for a deferred frame. */
async function mouseClick(element: Element) {
  const target = element.querySelector("svg") ?? element;
  const init = { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, detail: 1 };
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    await settle();
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
    await settle();
  });
}

/** The surface each test mounted, taken down before the next one runs — it
 *  polls the bridge on an interval, so one left alive keeps working. */
let mounted: (() => void) | null = null;

afterEach(() => {
  mounted?.();
  mounted = null;
});

// The DOM goes back LAST: React needs a `window` to unmount into, and its
// scheduler needs one for the task it has already queued.
afterAll(async () => {
  mounted?.();
  mounted = null;
  await act(async () => { await settle(); });
  await GlobalRegistrator.unregister();
});

/** Keep letting React work until `ready` answers true, or give up — the
 *  surface's first state arrives over two awaited hops (a timeout, then the
 *  bridge), so one settle is not reliably enough. */
async function waitFor(ready: () => boolean) {
  for (let attempt = 0; attempt < 25 && !ready(); attempt += 1) {
    await act(async () => { await settle(); });
  }
}

async function mount(
  state: DesktopBrowserPanelState,
  extra: Partial<DesktopBrowserBridge> = {},
  /** Where a capture lands (#474). Absent is a panel with no composer, which
   *  is what hides the camera rather than offering one that captures into
   *  nowhere. */
  onAttach?: (files: readonly File[], caption?: string) => void,
) {
  const recorded = makeBridge(state, extra);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <DesktopBrowserSurface
        bridge={recorded.bridge}
        scopeKey="session_a"
        projectId="project_a"
        {...(onAttach ? { onAttach } : {})}
      />,
    );
    await settle();
  });
  // The chrome is drawn from the shell's state, so nothing this file asserts
  // exists until that first read has landed.
  await waitFor(() => Boolean(host.querySelector('[role="tab"]')));
  let gone = false;
  const unmount = () => {
    if (gone) return;
    gone = true;
    act(() => root.unmount());
    host.remove();
  };
  mounted = unmount;
  return { ...recorded, host, unmount };
}

/** The `⋯` at the right end of the address row. */
const optionsTrigger = (host: Element) => host.querySelector('[aria-label="Browser options"]')!;

/** Every row the open menu is showing, in the order it shows them. */
const menuRows = () =>
  [...document.querySelectorAll('[aria-label="Browser options"] ~ *, [role="dialog"]')]
    .flatMap((popup) => [...popup.querySelectorAll("button")])
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);

/** One row of the open menu, by the words on it. */
const menuRow = (label: string) => {
  const found = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`No menu row labelled ${JSON.stringify(label)}; saw ${menuRows().join(" | ")}`);
  return found;
};

describe("the options menu", () => {
  test("holds the whole toolbox, in the order the issue asked for", async () => {
    const { host } = await mount(panelState());
    await mouseClick(optionsTrigger(host));

    const rows = menuRows();
    const order = ["Hard reload", "Open DevTools", "Open separate preview window", "Show device toolbar", "Appearance"];
    // Each named row is there, and each is after the one before it.
    const positions = order.map((label) => rows.findIndex((row) => row.startsWith(label)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Then the zoom readout, the profile, and the two destructive rows.
    expect(rows).toContain("100%");
    expect(rows).toContain("Profile: Work");
    expect(rows).toContain("Clear cookies…");
    expect(rows).toContain("Clear cache…");
  });

  /**
   * THE RULE EVERY MENU IN THIS PANEL OBEYS (`lib/native-view-overlay.ts`).
   * The shell composites the page ABOVE this DOM, so a menu that opens without
   * claiming the overlay opens behind the page — which is the same nothing,
   * from the chair.
   */
  test("takes the native browser view down while it is open", async () => {
    const { host, visibility } = await mount(panelState());
    expect(nativeViewOverlayHidden()).toBe(false);

    await mouseClick(optionsTrigger(host));
    expect(nativeViewOverlayHidden()).toBe(true);
    expect(visibility.at(-1)).toBe(false);

    await mouseClick(optionsTrigger(host));
    expect(nativeViewOverlayHidden()).toBe(false);
    expect(visibility.at(-1)).toBe(true);
  });

  test("hard reload and DevTools are the shell's own verbs, not a second reload", async () => {
    const { actions, host } = await mount(panelState());
    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Hard reload"));
    expect(actions.at(-1)).toEqual({ action: "hard-reload" });

    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Open DevTools"));
    expect(actions.at(-1)).toEqual({ action: "toggle-devtools" });
  });

  test("the DevTools row says which way it will go", async () => {
    const { host } = await mount(panelState({ tabs: [tab({ devtools: true })] }));
    await mouseClick(optionsTrigger(host));
    expect(menuRows()).toContain("Close DevTools");
    expect(menuRows()).not.toContain("Open DevTools");
  });

  test("the preview row opens a window, and offers the way back once it is open", async () => {
    const { actions, host, unmount } = await mount(panelState());
    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Open separate preview window"));
    expect(actions.at(-1)).toEqual({ action: "preview" });
    unmount();

    const previewed = await mount(panelState({ tabs: [tab({ preview: true })] }));
    await mouseClick(optionsTrigger(previewed.host));
    await mouseClick(menuRow("Bring back from separate window"));
    expect(previewed.actions.at(-1)).toEqual({ action: "end-preview" });
  });

  test("zoom reads the tab's own factor back, and − / + / reset step it", async () => {
    const { actions, host } = await mount(panelState({ tabs: [tab({ zoom: 1.25 })] }));
    await mouseClick(optionsTrigger(host));
    // The readout IS the reset button, so it is where the factor is said.
    expect(menuRows()).toContain("125%");

    await mouseClick(document.querySelector('[aria-label="Zoom out"]')!);
    expect(actions.at(-1)).toEqual({ action: "zoom", direction: "out" });
    await mouseClick(document.querySelector('[aria-label="Zoom in"]')!);
    expect(actions.at(-1)).toEqual({ action: "zoom", direction: "in" });
    await mouseClick(document.querySelector('[aria-label^="Reset zoom"]')!);
    expect(actions.at(-1)).toEqual({ action: "zoom", direction: "reset" });
  });

  test("appearance is a pane of the three answers, with the tab's own checked", async () => {
    const { actions, host } = await mount(panelState({ tabs: [tab({ colorScheme: "dark" })] }));
    await mouseClick(optionsTrigger(host));
    // The row says where it already is, so the submenu is not the only way
    // to find out.
    expect(menuRows().some((row) => row.startsWith("Appearance") && row.includes("Dark"))).toBe(true);

    await mouseClick(menuRow("AppearanceDark"));
    expect(menuRows()).toContain("Light");
    expect(menuRows()).toContain("System");
    await mouseClick(menuRow("Light"));
    expect(actions.at(-1)).toEqual({ action: "appearance", scheme: "light" });
  });

  /**
   * CLEARING IS CONFIRMED, AND THE CONFIRM SAYS WHAT IT REALLY DOES. The shell
   * clears the PARTITION — every site this identity is signed into — so a row
   * that fired on one press, or a sentence naming only the page in front of
   * you, would both be this menu lying about its own reach.
   */
  test("clear cookies asks first, names the profile, and names the page as an example", async () => {
    const { cleared, host } = await mount(panelState());
    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Clear cookies…"));
    expect(cleared).toEqual([]);

    const confirm = document.querySelector('[role="dialog"]')!;
    expect(confirm.textContent).toContain("Work");
    expect(confirm.textContent).toContain("example.com");
    expect(confirm.textContent).toContain("every site");

    await mouseClick(menuRow("Clear cookies"));
    expect(cleared).toEqual(["cookies"]);
  });

  test("cancelling a clear clears nothing and goes back to the menu", async () => {
    const { cleared, host } = await mount(panelState());
    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Clear cache…"));
    await mouseClick(menuRow("Cancel"));
    expect(cleared).toEqual([]);
    expect(menuRows()).toContain("Hard reload");
  });

  test("an older shell with no clear handler hides the rows rather than offering ones that throw", async () => {
    const { host } = await mount(panelState(), { clearBrowsingData: undefined });
    await mouseClick(optionsTrigger(host));
    expect(menuRows()).not.toContain("Clear cookies…");
    expect(menuRows()).not.toContain("Clear cache…");
    // The rest of the menu is unaffected.
    expect(menuRows()).toContain("Hard reload");
  });
});

/**
 * THE DEVICE TOOLBAR REPLACED "Fit panel" (#473). The viewport control was a
 * popover behind a glyph on the address row; it is a row of its own now, and
 * it IS the fixed viewport — off is fit mode, so there is one fact rather than
 * a toggle that can disagree with the page.
 */
describe("the device toolbar", () => {
  test("is absent in fit mode, and the menu's toggle is what turns it on", async () => {
    const { actions, host } = await mount(panelState());
    expect(host.querySelector('[aria-label="Device toolbar"]')).toBeNull();

    await mouseClick(optionsTrigger(host));
    expect(menuRow("Show device toolbar").getAttribute("aria-pressed")).toBe("false");
    await mouseClick(menuRow("Show device toolbar"));
    // Turning it ON is what puts the tab in fixed mode.
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, mode: "fixed" });
  });

  test("is shown for a fixed tab, and turning it off puts the tab back in fit mode", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { actions, host } = await mount(panelState({ tabs: [fixed] }));
    expect(host.querySelector('[aria-label="Device toolbar"]')).not.toBeNull();

    await mouseClick(optionsTrigger(host));
    expect(menuRow("Show device toolbar").getAttribute("aria-pressed")).toBe("true");
    await mouseClick(menuRow("Show device toolbar"));
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, mode: "fit" });
  });

  test("carries the preset, the two numbers, rotate, and what the panel is scaling to", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { host } = await mount(panelState({ tabs: [fixed] }));
    const toolbar = host.querySelector('[aria-label="Device toolbar"]')!;

    expect(toolbar.textContent).toContain("Phone");
    expect((toolbar.querySelector('[aria-label="Viewport width"]') as HTMLInputElement).value).toBe("390");
    expect((toolbar.querySelector('[aria-label="Viewport height"]') as HTMLInputElement).value).toBe("844");
    expect(toolbar.querySelector('[aria-label="Rotate the viewport"]')).not.toBeNull();
    // The presentation scale, said out loud: a page laid out at 1280 in a
    // 640px column is being shown at half size, and that is worth knowing
    // before judging a layout by it.
    expect(toolbar.textContent).toContain("50%");
  });

  test("rotate swaps the two numbers rather than inventing a size", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { actions, host } = await mount(panelState({ tabs: [fixed] }));
    await mouseClick(host.querySelector('[aria-label="Rotate the viewport"]')!);
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, width: 844, height: 390 });
  });

  test("the preset picker is a menu, so it takes the native view down too", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { actions, host } = await mount(panelState({ tabs: [fixed] }));
    const picker = host.querySelector('[aria-label^="Device:"]')!;

    await mouseClick(picker);
    expect(nativeViewOverlayHidden()).toBe(true);
    await mouseClick(menuRow("Tablet768×1024"));
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, preset: "tablet" });
    expect(nativeViewOverlayHidden()).toBe(false);
  });

  /**
   * A SIZE IS COMMITTED WHEN IT IS A SIZE — the toolbar's fields hold a draft
   * and commit on submit or on blur, so "1" on the way to "1024" relayouts
   * nothing. That rule is `sizeFromFields` and it is tested where it lives
   * (`lib/browser-viewport.test.ts`); what belongs here is that the fields
   * show the tab's own numbers, which the test above asserts.
   */
});

/**
 * #475 — THE PAGE FILLS THE PANEL, AND STAYS PUT BEHIND A MENU.
 *
 * The host used to sit 8px inside a rounded card of its own, because a
 * `WebContentsView` ignores CSS radius and an inset was the only way to clear
 * the panel's corner. The page therefore read as a small box with a margin
 * inside a panel that was already a rounded rectangle.
 */
const viewportHost = (host: Element) => host.querySelector('[aria-label="Live browser viewport"]')!;
const frozenImage = (host: Element) => viewportHost(host).querySelector("img");

describe("the live viewport's box", () => {
  test("fit mode runs to the panel's edges and takes the panel body's own corner", async () => {
    const { host } = await mount(panelState());
    const box = viewportHost(host).className;
    expect(box).toContain("md:rounded-b-xl");
    expect(box).not.toContain("md:mx-2");
    expect(box).not.toContain("md:mb-2");
  });

  test("a fixed viewport keeps the card — its stage is a device shown inside the panel, and the resize rails live in that margin", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { host } = await mount(panelState({ tabs: [fixed] }));
    const box = viewportHost(host).className;
    expect(box).toContain("md:mx-2");
    expect(box).toContain("md:mb-2");
    expect(box).toContain("md:rounded-lg");
  });
});

describe("the frozen frame a menu opens over", () => {
  test("the shell's last frame of the page is painted at the rect the view filled, and goes when the view is back", async () => {
    const frame = { data: "cG5n", mimeType: "image/png", rect: { x: 0, y: 0, width: 640, height: 400 } };
    const froze: string[] = [];
    const { host, visibility } = await mount(panelState(), {
      freezeView: async (scopeKey: string) => {
        froze.push(scopeKey);
        return frame;
      },
    });

    await mouseClick(optionsTrigger(host));
    await waitFor(() => Boolean(frozenImage(host)));
    expect(froze).toEqual(["session_a"]);
    expect(frozenImage(host)!.getAttribute("src")).toBe("data:image/png;base64,cG5n");
    // Freezing IS the hide — the shell captures and then puts the view down in
    // one call, so the panel never asks for a plain one alongside it.
    expect(visibility).not.toContain(false);

    await mouseClick(optionsTrigger(host));
    await waitFor(() => !frozenImage(host));
    expect(visibility.at(-1)).toBe(true);
  });

  test("a shell that has nothing to freeze paints nothing, and the view still goes down", async () => {
    // A blank tab, a capture past its budget, a page with no frame: null is
    // the shell saying it hid the view with no picture to show for it.
    const { host, visibility } = await mount(panelState(), { freezeView: async () => null });
    await mouseClick(optionsTrigger(host));
    expect(frozenImage(host)).toBeNull();
    expect(nativeViewOverlayHidden()).toBe(true);

    await mouseClick(optionsTrigger(host));
    expect(visibility.at(-1)).toBe(true);
  });
});

/** The panel has nothing to draw for a tab that is in a window of its own —
 *  the live view was MOVED there, not copied. */
describe("a previewed tab", () => {
  test("says where the page went, with the way back on it", async () => {
    const { actions, host } = await mount(panelState({ tabs: [tab({ preview: true })] }));
    expect(host.textContent).toContain("This tab is open in a window of its own.");

    const back = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Bring it back")!;
    await mouseClick(back);
    expect(actions.at(-1)).toEqual({ action: "end-preview" });
  });
});

/**
 * THE CAMERA AND THE PEN (#474).
 *
 * WHAT IS MOUNTED AND CLICKED HERE is the `⋯` menu's three rows, because they
 * are the ones that exist at EVERY width: the row's own two glyphs are gated
 * on a measured `ResizeObserver` width, which a DOM with no layout never
 * reports. The arithmetic that gates them is pinned in `browser-live.test.ts`
 * beside this, and the markup's gate is scanned there too — between the three
 * there is no width at which a capture is unreachable and none at which the
 * address bar is crushed to reach one.
 *
 * A 1×1 PNG stands in for the frame. Nothing here decodes it: what is asserted
 * is the shape that leaves the panel — a `File` on the composer's list, and a
 * caption in the draft carrying the address the picture is of.
 */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A shell that can capture, recording what it was asked for. */
function capturingBridge(patch: Record<string, unknown> = {}) {
  const asked: Array<{ fullPage?: boolean; elements?: boolean } | undefined> = [];
  return {
    asked,
    capture: async (_scope: string, options?: { fullPage?: boolean; elements?: boolean }) => {
      asked.push(options);
      return {
        data: PNG_1PX,
        mimeType: "image/png",
        url: "https://example.com/",
        title: "Example",
        width: 1280,
        height: 800,
        fullPage: Boolean(options?.fullPage),
        elements: options?.elements ? [{ role: "button", name: "Save", selector: "#save", x: 4, y: 4, width: 40, height: 20 }] : undefined,
        ...patch,
      };
    },
  };
}

describe("the browser's camera", () => {
  test("a screenshot becomes an attachment, and its caption carries the address and the viewport", async () => {
    const landed: Array<{ files: readonly File[]; caption?: string }> = [];
    const shell = capturingBridge();
    const { host } = await mount(panelState(), { capture: shell.capture }, (files, caption) => landed.push({ files, caption }));

    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Screenshot the viewport"));
    await waitFor(() => landed.length > 0);

    expect(shell.asked.at(-1)).toEqual({});
    const [sent] = landed;
    expect(sent!.files).toHaveLength(1);
    expect(sent!.files[0]!.name).toBe("screenshot-example.com.png");
    expect(sent!.files[0]!.type).toBe("image/png");
    // A real decode, not the base64 handed back: the composer holds bytes.
    expect(sent!.files[0]!.size).toBeGreaterThan(0);
    expect(sent!.caption).toBe("Screenshot of https://example.com/ (1280×800).");
  });

  test("the full page is the same button's second item, and it says so in the caption", async () => {
    const landed: Array<{ files: readonly File[]; caption?: string }> = [];
    const shell = capturingBridge();
    const { host } = await mount(panelState(), { capture: shell.capture }, (files, caption) => landed.push({ files, caption }));

    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Screenshot the full page"));
    await waitFor(() => landed.length > 0);

    expect(shell.asked.at(-1)).toEqual({ fullPage: true });
    expect(landed[0]!.caption).toBe("Full-page screenshot of https://example.com/ (1280×800).");
  });

  test("a capture that fails is said out loud, not swallowed", async () => {
    const landed: File[][] = [];
    const { host } = await mount(
      panelState(),
      { capture: async () => { throw new Error("There is no page loaded in this tab to capture."); } },
      (files) => landed.push([...files]),
    );

    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Screenshot the viewport"));
    await waitFor(() => Boolean(host.querySelector('[role="alert"]')));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no page loaded");
    expect(landed).toHaveLength(0);
  });

  test("with nowhere for a capture to land, the rows are not offered at all", async () => {
    // A shell that CAN capture, but no composer to capture into.
    const { host } = await mount(panelState(), { capture: capturingBridge().capture });
    await mouseClick(optionsTrigger(host));
    expect(menuRows()).not.toContain("Screenshot the viewport");
    expect(menuRows()).not.toContain("Annotate this page");
    // ...and the rest of the menu is untouched.
    expect(menuRows()).toContain("Hard reload");
  });

  test("an older shell with no capture handler offers nothing rather than a row that throws", async () => {
    const { host } = await mount(panelState(), {}, () => {});
    await mouseClick(optionsTrigger(host));
    expect(menuRows()).not.toContain("Screenshot the viewport");
    expect(menuRows()).toContain("Hard reload");
  });
});

describe("annotate mode", () => {
  test("it asks for the element boxes in the same call as the frame, and takes the native view down", async () => {
    const shell = capturingBridge();
    const { host, visibility } = await mount(panelState(), { capture: shell.capture }, () => {});
    expect(nativeViewOverlayHidden()).toBe(false);

    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Annotate this page"));
    await waitFor(() => Boolean(host.querySelector('[aria-label="Annotate the page"]')));

    // ONE call, carrying both — not a frame and then a snapshot of a page
    // that has since been hidden.
    expect(shell.asked.at(-1)).toEqual({ elements: true });
    // The page is down for as long as the overlay is up.
    expect(nativeViewOverlayHidden()).toBe(true);
    expect(visibility.at(-1)).toBe(false);
    // The frozen frame is what is drawn, at the tab's own viewport.
    const frame = host.querySelector("img[alt^='Frozen frame']") as HTMLImageElement | null;
    expect(frame?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_1PX}`);
    expect(host.textContent).toContain("1280×800");
  });

  test("every tool the issue named is there, and Done puts the page back", async () => {
    const shell = capturingBridge();
    const { host } = await mount(panelState(), { capture: shell.capture }, () => {});
    await mouseClick(optionsTrigger(host));
    await mouseClick(menuRow("Annotate this page"));
    await waitFor(() => Boolean(host.querySelector('[aria-label="Annotate the page"]')));

    const overlay = host.querySelector('[aria-label="Annotate the page"]')!;
    const tools = [...overlay.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(tools).toEqual(expect.arrayContaining(["Rectangle", "Arrow", "Freehand", "Text", "Pick element"]));
    // Undo and Clear start unpressable: there is nothing on the frame yet.
    const undo = overlay.querySelector('[aria-label="Undo the last mark"]') as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    const done = [...overlay.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done")!;
    await mouseClick(done);
    await waitFor(() => !host.querySelector('[aria-label="Annotate the page"]'));
    // The page is live again the moment the overlay goes.
    expect(nativeViewOverlayHidden()).toBe(false);
  });
});
