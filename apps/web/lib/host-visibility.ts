"use client";

/**
 * IS ANYBODY LOOKING AT THIS WINDOW — one predicate for the shell and the
 * browser, issue #834.
 *
 * Use this, NOT `document.visibilityState`. The desktop shell sets
 * `backgroundThrottling: false` (the anti-flicker half of the translucent
 * window), and that flag suppresses the Page Visibility API outright: inside
 * the shell `visibilityState` reads "visible" forever and `visibilitychange`
 * never fires, so a gate written against it is dead code in the app we ship.
 * The main process still sees hide, minimise, ⌘H and occlusion, and says so
 * over `telarDesktop.visibility` (apps/desktop/window-visibility.js).
 *
 * Without that bridge — a browser tab, a phone, a shell packaged before it
 * existed — this is the real Page Visibility API, so the browser build stays
 * gated too.
 *
 * A MODULE-LEVEL STORE, like `modifier-held.ts`: one bridge subscription for
 * however many readers, dropped when the last one leaves. Listeners hear
 * CHANGES only, never the same answer twice.
 */

import { useSyncExternalStore } from "react";

type DesktopVisibility = {
  get: () => Promise<boolean>;
  onChange: (listener: (visible: boolean) => void) => () => void;
};

function desktopVisibility(): DesktopVisibility | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { telarDesktop?: { visibility?: DesktopVisibility } }).telarDesktop?.visibility;
}

const listeners = new Set<() => void>();
/** The shell's last word; undefined until it has spoken, and read as visible —
 *  a wrong "visible" is one poll too many, a wrong "hidden" is a page that
 *  silently stops. */
let shellVisible: boolean | undefined;
let last = true;
let detach: (() => void) | undefined;

/** Whether the window this page is in can be seen right now. */
export function hostVisible(): boolean {
  if (typeof document === "undefined") return true;
  if (desktopVisibility()) return shellVisible ?? true;
  return document.visibilityState !== "hidden";
}

function emit(): void {
  const now = hostVisible();
  if (now === last) return;
  last = now;
  for (const listener of listeners) listener();
}

function attach(): () => void {
  const shell = desktopVisibility();
  if (!shell) {
    document.addEventListener("visibilitychange", emit);
    return () => document.removeEventListener("visibilitychange", emit);
  }
  // A push that lands while `get` is in flight is newer than its answer.
  let pushed = false;
  const off = shell.onChange((visible) => {
    pushed = true;
    shellVisible = visible;
    emit();
  });
  void shell.get().then(
    (visible) => {
      if (pushed || detach !== stop) return;
      shellVisible = visible;
      emit();
    },
    () => undefined,
  );
  const stop = () => {
    off();
    shellVisible = undefined;
  };
  return stop;
}

/** Hear every change of `hostVisible()`. Returns the unsubscribe. */
export function subscribeHostVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  listeners.add(listener);
  if (listeners.size === 1) {
    last = hostVisible();
    detach = attach();
  }
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    detach?.();
    detach = undefined;
  };
}

/** `hostVisible()` as React state. Server render assumes visible. */
export function useHostVisibility(): boolean {
  return useSyncExternalStore(subscribeHostVisibility, hostVisible, () => true);
}
