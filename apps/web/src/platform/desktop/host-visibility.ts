"use client";

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

export function useHostVisibility(): boolean {
  return useSyncExternalStore(subscribeHostVisibility, hostVisible, () => true);
}
