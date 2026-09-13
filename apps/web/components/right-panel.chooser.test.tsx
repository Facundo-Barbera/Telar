/**
 * THE "+" CHOOSER OPENS ON A MOUSE CLICK (#349).
 *
 * WHY THIS FILE HAS A DOM AND THE STRIP'S OTHER TESTS DO NOT. Everything else
 * about this strip is a fold you can render to a string — a label, a count, a
 * suffix — and `right-panel.render.test.tsx` pins those with
 * `renderToStaticMarkup`. A press is not one of those: the defect was that the
 * menu's open never survived the release, and nothing short of dispatching the
 * four events a browser dispatches can say whether it does. So this one file
 * registers a DOM, mounts the panel, and clicks.
 *
 * THE FRAME IS THE POINT. A menu trigger toggles from `mousedown` but defers
 * the state change to a `requestAnimationFrame`; in the packaged shell that
 * frame did not arrive and the press was swallowed, while the keyboard — which
 * opens synchronously from `click` — still worked. Every claim here is
 * therefore made twice: once with frames, once with the frame taken away.
 *
 * The DOM is registered for this file and handed back in `afterAll`, because
 * the suite shares one process and its neighbours are written for a world with
 * no `window` in it. That is late for one thing only — the primitives freeze
 * whether they have layout effects at their first import — and the preload
 * (scripts/test-dom.mjs) settles that before any test file loads.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RightPanel, type PanelTabItem } from "./right-panel";
import { nativeViewOverlayHidden } from "@/lib/native-view-overlay";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const tab = (id: string, kind: string, params: Record<string, string> = {}): PanelTabItem =>
  ({ id, kind, params }) as PanelTabItem;

/** The panel, mounted with a strip that already holds a tab — the state the
 *  defect was reported in, and the one where the "+" is the only way to open
 *  another surface. */
function mount(tabs: PanelTabItem[] = [tab("editor", "editor", { path: "a.ts" })]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <RightPanel
        sessionId="session_a"
        projectId="project_a"
        tabs={tabs}
        tab={tabs[0]?.id}
        onTabChange={() => {}}
        onOpenTab={() => {}}
        onCloseTab={() => {}}
        onClose={() => {}}
      />,
    );
  });
  const trigger = host.querySelector('[aria-label="Open a surface"]')!;
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, trigger, unmount };
}

/**
 * WHETHER THE CHOOSER IS OPEN, read off the trigger rather than off the
 * popup's presence. A closing menu keeps its popup mounted until the exit
 * animation finishes — which, in the half of these tests that takes the
 * animation frame away, is never — so the list in the DOM answers "was it ever
 * opened", not "is it open". `aria-expanded` is the state itself, and it is
 * what a screen reader is told.
 */
const chooserOpen = (trigger: Element) => trigger.getAttribute("aria-expanded") === "true";

/** The list itself reached the DOM, with the surfaces on it. */
const chooserLists = (label: string) =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((item) => item.textContent?.includes(label));

/** A quiet moment — long enough for a frame, when there are frames. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * A REAL MOUSE PRESS: the events a browser sends, in order, on the deepest
 * element under the pointer (the icon, not the button around it), with the
 * press held long enough that anything deferred to a frame has had one.
 */
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

/** A keyboard activation: a key, then the `detail: 0` click a button
 *  synthesises from it — and no pointer events at all. */
async function keyboardPress(element: Element) {
  const init = { bubbles: true, cancelable: true };
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { ...init, key: "Enter" }));
    element.dispatchEvent(new MouseEvent("click", { ...init, detail: 0 }));
    await settle();
  });
}

/** The same body, run once normally and once with the animation frame that
 *  Base UI defers its open to taken away. */
function withAndWithoutFrames(name: string, body: () => Promise<void>) {
  test(name, body);
  test(`${name}, with no animation frame`, async () => {
    const had = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame;
    try {
      await body();
    } finally {
      globalThis.requestAnimationFrame = had;
    }
  });
}

describe("the surface chooser", () => {
  withAndWithoutFrames("opens on a mouse click, with the surfaces on it", async () => {
    const { trigger, unmount } = mount();
    await mouseClick(trigger);
    expect(chooserOpen(trigger)).toBe(true);
    expect(chooserLists("Diff")).toBe(true);
    unmount();
  });

  withAndWithoutFrames("closes on the next mouse click, so the button still toggles", async () => {
    const { trigger, unmount } = mount();
    await mouseClick(trigger);
    expect(chooserOpen(trigger)).toBe(true);
    await mouseClick(trigger);
    expect(chooserOpen(trigger)).toBe(false);
    unmount();
  });

  withAndWithoutFrames("still opens from the keyboard, which never had a press to repair", async () => {
    const { trigger, unmount } = mount();
    await keyboardPress(trigger);
    expect(chooserOpen(trigger)).toBe(true);
    unmount();
  });

  /**
   * THE NATIVE VIEW IS THE OTHER HALF OF "a click opens it". In the shell the
   * browser is a real view composited ABOVE this DOM, so a menu that opens
   * without claiming the overlay opens behind the page — which is the same
   * nothing, from the chair. The claim is what `browser-live.tsx` listens to;
   * asserting it here covers the with-a-native-view case without a shell.
   */
  withAndWithoutFrames("takes the native browser view down while it is open", async () => {
    const { trigger, unmount } = mount();
    expect(nativeViewOverlayHidden()).toBe(false);
    await mouseClick(trigger);
    expect(nativeViewOverlayHidden()).toBe(true);
    await mouseClick(trigger);
    expect(nativeViewOverlayHidden()).toBe(false);
    unmount();
  });
});
