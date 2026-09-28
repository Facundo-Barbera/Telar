"use client";

/**
 * Use this, not `document.visibilityState`: the shell's `backgroundThrottling: false` pins that to
 * "visible". The shell reports visibility via `telarDesktop.visibility`; elsewhere this falls back
 * to the Page Visibility API. Listeners hear changes only.
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
/** Undefined until the shell answers, read as visible: a wrong "hidden" silently stops pages. */
let shellVisible: boolean | undefined;
let last = true;
let detach: (() => void) | undefined;

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

/** Returns the unsubscribe. */
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

/** Server render assumes visible. */
export function useHostVisibility(): boolean {
  return useSyncExternalStore(subscribeHostVisibility, hostVisible, () => true);
}
