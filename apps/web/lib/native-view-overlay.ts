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
 *
 * AND THE PAGE STILL LOOKS LIKE IT IS THERE (#475). Hiding is what makes the
 * menu visible; it is also what made the page BLINK OUT on every ⋯. Electron
 * cannot composite DOM over a `WebContentsView`, so the honest answer is a
 * picture: the shell captures the page's last frame, the panel paints it into
 * the host at the view's own rect, and only then does the view go down. The
 * swap is `createOverlayFreezer` below.
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

/** The page's last pixels, and the rect they filled — in WINDOW coordinates,
 *  the same space the bounds the shell was given are in. */
export type FrozenFrame = {
  data: string;
  mimeType: string;
  rect: { x: number; y: number; width: number; height: number };
};

/** The three things the swap needs from the surface that owns the view. */
export type OverlayShell = {
  /**
   * Capture the page, THEN hide the view — ONE call, because a view that is
   * already down has no frame to give. Answers null when there is nothing to
   * paint (an older shell, a blank tab, a capture that failed or ran past its
   * budget); the view is hidden either way.
   */
  freeze: () => Promise<FrozenFrame | null>;
  /** Put the view back. */
  show: () => Promise<void>;
  /** Paint a frame into the host, or clear the one that is there. */
  paint: (frame: FrozenFrame | null) => void;
};

/**
 * THE FROZEN FRAME'S LIFECYCLE (#475) — the swap that runs each time the
 * overlay count crosses zero. Returns a function to hand the same boolean
 * `onNativeViewOverlay` reports.
 *
 * SERIALIZED, because both halves are asynchronous and a menu can close
 * before the capture it opened has landed. Without the queue, a freeze's hide
 * could arrive AFTER the show that was meant to undo it and leave the panel
 * blank with no menu on it — the one failure worse than the blink. Requests
 * superseded before their turn are DROPPED rather than run late: the menu
 * that asked for them is already gone.
 *
 * SHOW FIRST, DROP THE FRAME AFTER. The real view covers the frame the moment
 * it is back; clearing first would show the empty host for a frame, which is
 * the blink wearing a different hat.
 */
export function createOverlayFreezer(shell: OverlayShell): (hidden: boolean) => Promise<void> {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  return (hidden: boolean) => {
    const mine = (generation += 1);
    queue = queue
      .then(async () => {
        if (generation !== mine) return;
        if (!hidden) {
          await shell.show();
          shell.paint(null);
          return;
        }
        let frame: FrozenFrame | null = null;
        try {
          frame = await shell.freeze();
        } catch {
          // The shell could not freeze. The view is down regardless — a menu
          // that cannot be seen is worse than a page that blinked.
          frame = null;
        }
        // The menu closed while the capture was in flight: the view is on its
        // way back and this frame would paint over a live page.
        if (generation !== mine) return;
        shell.paint(frame);
      })
      // One failed swap must not break every later one — the queue is the
      // only thing keeping hide and show in order.
      .catch(() => undefined);
    return queue;
  };
}
