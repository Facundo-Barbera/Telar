import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { presentationZoomLabel } from "../model";
import type { DesktopBrowserBridge, DesktopBrowserPanelState, DesktopBrowserTab } from "../types";
import { DesktopBrowserSurface } from "./desktop-browser-surface";
import { claimNativeView, nativeViewOverlayHidden } from "@/platform/desktop/native-view-overlay";

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

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

let mounted: (() => void) | null = null;

afterEach(() => {
  mounted?.();
  mounted = null;
});

afterAll(async () => {
  mounted?.();
  mounted = null;
  await act(async () => { await settle(); });
  await GlobalRegistrator.unregister();
});

async function waitFor(ready: () => boolean) {
  for (let attempt = 0; attempt < 25 && !ready(); attempt += 1) {
    await act(async () => { await settle(); });
  }
}

async function mount(
  state: DesktopBrowserPanelState,
  extra: Partial<DesktopBrowserBridge> = {},
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
  await waitFor(() => Boolean(host.querySelector('[role="tab"]')));
  let gone = false;
  const unmount = () => {
    if (gone) return;
    gone = true;
    act(() => root.unmount());
    host.remove();
  };
  mounted = unmount;
  return { ...recorded, host, root, unmount };
}

const optionsTrigger = (host: Element) => host.querySelector('[aria-label="Browser options"]')!;

const menuRows = () =>
  [...document.querySelectorAll('[aria-label="Browser options"] ~ *, [role="dialog"]')]
    .flatMap((popup) => [...popup.querySelectorAll("button")])
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);

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
    const positions = order.map((label) => rows.findIndex((row) => row.startsWith(label)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(rows).toContain("100%");
    expect(rows).toContain("Profile: Work");
    expect(rows).toContain("Clear cookies…");
    expect(rows).toContain("Clear cache…");
  });

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
    expect(menuRows().some((row) => row.startsWith("Appearance") && row.includes("Dark"))).toBe(true);

    await mouseClick(menuRow("AppearanceDark"));
    expect(menuRows()).toContain("Light");
    expect(menuRows()).toContain("System");
    await mouseClick(menuRow("Light"));
    expect(actions.at(-1)).toEqual({ action: "appearance", scheme: "light" });
  });

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
    expect(menuRows()).toContain("Hard reload");
  });
});

describe("the device toolbar", () => {
  test("is absent in fit mode, and the menu's toggle is what turns it on", async () => {
    const { actions, host } = await mount(panelState());
    expect(host.querySelector('[aria-label="Device toolbar"]')).toBeNull();

    await mouseClick(optionsTrigger(host));
    expect(menuRow("Show device toolbar").getAttribute("aria-pressed")).toBe("false");
    await mouseClick(menuRow("Show device toolbar"));
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
    await mouseClick(menuRow("iPad Mini768×1024"));
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, preset: "ipad-mini" });
    expect(nativeViewOverlayHidden()).toBe(false);
  });

  test("the preset picker is grouped, marks the tab's preset through an older name, and leads with fit", async () => {
    const fixed = tab({ viewport: { width: 390, height: 844, preset: "phone", mode: "fixed" } });
    const { actions, host } = await mount(panelState({ tabs: [fixed] }));
    await mouseClick(host.querySelector('[aria-label^="Device:"]')!);

    const groups = [...document.querySelectorAll('[role="dialog"] [role="group"]')].map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Phones", "Tablets", "Desktop", "Foldables"]);
    expect(menuRow("iPhone 12/13 Pro390×844").getAttribute("aria-pressed")).toBe("true");
    expect(menuRows()[0]).toBe("Fit to panel");

    await mouseClick(menuRow("Fit to panel"));
    expect(actions.at(-1)).toEqual({ action: "resize", index: 0, mode: "fit" });
  });

});

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
    expect(visibility).not.toContain(false);

    await mouseClick(optionsTrigger(host));
    await waitFor(() => !frozenImage(host));
    expect(visibility.at(-1)).toBe(true);
  });

  test("a shell that has nothing to freeze paints nothing, and the view still goes down", async () => {
    const { host, visibility } = await mount(panelState(), { freezeView: async () => null });
    await mouseClick(optionsTrigger(host));
    expect(frozenImage(host)).toBeNull();
    expect(nativeViewOverlayHidden()).toBe(true);

    await mouseClick(optionsTrigger(host));
    expect(visibility.at(-1)).toBe(true);
  });

  test("a panel menu that closes as the surface unmounts leaves the view down", async () => {
    const { root, visibility } = await mount(panelState(), { freezeView: async () => null });
    const release = claimNativeView();
    await act(async () => {});

    await act(async () => {
      release();
      root.unmount();
    });
    await act(async () => {});

    expect(nativeViewOverlayHidden()).toBe(false);
    expect(visibility.at(-1)).toBe(false);
  });
});

describe("a previewed tab", () => {
  test("says where the page went, with the way back on it", async () => {
    const { actions, host } = await mount(panelState({ tabs: [tab({ preview: true })] }));
    expect(host.textContent).toContain("This tab is open in a window of its own.");

    const back = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Bring it back")!;
    await mouseClick(back);
    expect(actions.at(-1)).toEqual({ action: "end-preview" });
  });
});

const extensionWithHelperExit = (lastExitCode: number) => ({
  id: "ext",
  name: "1Password",
  phase: "ready" as const,
  health: { workerErrors: {}, native: { state: "unavailable" as const, helpers: 0, lastExitCode } },
});

describe("a password manager that refuses this browser", () => {
  test("says how to authorize Telar once, with a button that opens the app", async () => {
    let opened = 0;
    const { host } = await mount(panelState(), {
      extensionStatus: async () => extensionWithHelperExit(1),
      openPasswordManagerApp: async () => { opened += 1; return { ok: true }; },
    });
    await waitFor(() => Boolean(host.textContent?.includes("Add Browser")));
    expect(host.textContent).toContain("open Settings → Browser → Add Browser and choose Telar");
    const open = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open 1Password")!;
    await mouseClick(open);
    expect(opened).toBe(1);
  });

  test("a helper that crashed some other way does not ask for authorization", async () => {
    const { host } = await mount(panelState(), { extensionStatus: async () => extensionWithHelperExit(2) });
    await act(async () => { await settle(); });
    expect(host.textContent).not.toContain("Add Browser");
  });
});

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
    const { host } = await mount(panelState(), { capture: capturingBridge().capture });
    await mouseClick(optionsTrigger(host));
    expect(menuRows()).not.toContain("Screenshot the viewport");
    expect(menuRows()).not.toContain("Annotate this page");
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

    expect(shell.asked.at(-1)).toEqual({ elements: true });
    expect(nativeViewOverlayHidden()).toBe(true);
    expect(visibility.at(-1)).toBe(false);
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
    const undo = overlay.querySelector('[aria-label="Undo the last mark"]') as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    const done = [...overlay.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done")!;
    await mouseClick(done);
    await waitFor(() => !host.querySelector('[aria-label="Annotate the page"]'));
    expect(nativeViewOverlayHidden()).toBe(false);
  });
});

describe("the panel drag", () => {
  test("republishes bounds SYNCHRONOUSLY on telar:panel-resized — the native view must not trail the handle by a frame", async () => {
    let bounds = 0;
    await mount(panelState(), { setBounds: async () => { bounds += 1; } });
    const before = bounds;

    window.dispatchEvent(new Event("telar:panel-resized"));
    expect(bounds).toBe(before + 1);

    window.dispatchEvent(new Event("telar:panel-resized"));
    window.dispatchEvent(new Event("telar:panel-resized"));
    expect(bounds).toBe(before + 3);
  });
});

describe("the device toolbar's zoom readout", () => {
  test("fit says so with the scale it lands on; a picked zoom is its percentage", () => {
    expect(presentationZoomLabel({ width: 1280, height: 800, scale: 0.5, zoom: "fit", rect: { x: 0, y: 0, width: 640, height: 400 } })).toBe("Fit · 50%");
    expect(presentationZoomLabel({ width: 390, height: 844, scale: 0.75, zoom: 0.75, rect: { x: 0, y: 0, width: 293, height: 633 } })).toBe("75%");
    expect(presentationZoomLabel({ width: 1280, height: 800, scale: 1, rect: { x: 0, y: 0, width: 1280, height: 800 } })).toBe("Fit · 100%");
    expect(presentationZoomLabel(null)).toBe("Fit · 100%");
  });
});
