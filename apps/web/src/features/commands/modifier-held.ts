"use client";

import { useSyncExternalStore } from "react";
import { isEditableTarget } from "./command-keys";
import { keyCapPlatformFor, type KeyCapPlatform } from "./key-caps";

export type ModifierEventLike = {
  type?: string | undefined;
  metaKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
};

export function modifierHeldAfter(event: ModifierEventLike, platform: KeyCapPlatform, focused: unknown): boolean {
  if (event.type === "blur" || event.type === "visibilitychange") return false;
  if (isEditableTarget(focused)) return false;
  return platform === "mac" ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

let held = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (held === next) return;
  held = next;
  for (const listener of listeners) listener();
}

let platform: KeyCapPlatform | undefined;
function commandModifierPlatform(): KeyCapPlatform {
  platform ??= keyCapPlatformFor(typeof navigator === "undefined" ? "" : `${navigator.userAgent} ${navigator.platform ?? ""}`);
  return platform;
}

export function forgetModifierPlatform(): void {
  platform = undefined;
}

function onKey(event: KeyboardEvent) {
  publish(modifierHeldAfter(event, commandModifierPlatform(), document.activeElement));
}
const onLeave = () => publish(false);

export function subscribeModifierHeld(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first && typeof document !== "undefined") {
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKey, true);
    document.addEventListener("visibilitychange", onLeave);
    window.addEventListener("blur", onLeave);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || typeof document === "undefined") return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKey, true);
    document.removeEventListener("visibilitychange", onLeave);
    window.removeEventListener("blur", onLeave);
    held = false;
  };
}

export function modifierHeldSnapshot(): boolean {
  return held;
}

function serverModifierHeld(): boolean {
  return false;
}

export function useModifierHeld(): boolean {
  return useSyncExternalStore(subscribeModifierHeld, modifierHeldSnapshot, serverModifierHeld);
}
