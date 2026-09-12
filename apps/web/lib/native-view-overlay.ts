"use client";

/**
 * THE ONE REASON THE COCKPIT'S MENUS USED TO BE INLINE ROWS.
 *
 * The desktop shell glues a native `WebContentsView` under the right panel,
 * and that view is composited ABOVE this renderer's DOM. A portal menu
 * dropped over the panel is therefore not "on top" of anything — the page
 * draws over it. That is why the panel's "+" chooser became a bar under the
 * tab strip (ece446e8) and why the browser's profile and viewport controls
 * became inline rows: a row changes the panel's LAYOUT, so the native view is
 * pushed down rather than covered.
 *
 * The bridge has had the answer all along: `setVisible(scope, false)`, which
 * the start page already uses to get the page out of its way. So the rule
 * here is simply — WHILE ANY MENU IN THE RIGHT PANEL IS OPEN, THE NATIVE VIEW
 * IS HIDDEN. The DOM underneath, menu included, is then the whole picture.
 *
 * COUNTED, NOT A BOOLEAN. One menu closing as another opens must never leave
 * the view hidden, and two menus open at once (a submenu, a tooltip's
 * popover) must not have the first close re-show the page under the second.
 *
 * MODULE STATE, deliberately: the menus live all over the panel's tree
 * (`right-panel.tsx`, `browser-live.tsx`, the surfaces below them) while the
 * native view is ONE window-wide surface owned by the live browser. Threading
 * a context through every surface to say "a menu is open somewhere" would be
 * the same global with more ceremony. A renderer has one of these views.
 *
 * NO-OP WITHOUT THE SHELL. On the web build nothing subscribes, so the hook
 * costs a counter increment and reaches nobody.
 */
import { useEffect } from "react";

type OverlayListener = (hidden: boolean) => void;

let openCount = 0;
const listeners = new Set<OverlayListener>();

function publish(): void {
  const hidden = openCount > 0;
  for (const listener of listeners) listener(hidden);
}

/**
 * The live browser surface's side: be told to hide the native view while a
 * menu is open, and to show it again when the last one closes. Called once on
 * subscribe with the current state, so a surface that mounts under an open
 * menu does not reveal the page behind it. Returns the unsubscribe.
 */
export function onNativeViewOverlay(listener: OverlayListener): () => void {
  listeners.add(listener);
  listener(openCount > 0);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Claim the view for one menu; call the returned release when it closes.
 * Idempotent per claim — releasing twice does not free somebody else's.
 */
export function claimNativeView(): () => void {
  openCount += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount -= 1;
    publish();
  };
}

/**
 * A MENU'S SIDE: hide the native browser view while `open`. Pass the same
 * boolean the menu's `open` prop is driven by — the menu must be CONTROLLED,
 * because an uncontrolled one has no state to hand over here.
 */
export function useNativeViewOverlay(open: boolean): void {
  useEffect(() => (open ? claimNativeView() : undefined), [open]);
}

/** Whether anything currently claims the view — for tests and assertions. */
export function nativeViewOverlayHidden(): boolean {
  return openCount > 0;
}
