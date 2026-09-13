"use client";

/**
 * IS THE COMMAND MODIFIER DOWN RIGHT NOW — the one fact behind #401's hold-⌘
 * hints, answered for the whole cockpit by one set of listeners.
 *
 * A MODULE STORE RATHER THAN A CONTEXT, and rather than a listener per hint.
 * The subscribers are scattered — nine rail rows, a menu row, a tab strip, the
 * search field, the rail toggle — and they come and go with their surfaces; a
 * provider threaded through all of them would be ceremony around a boolean, and
 * a `keydown` listener per hint would be thirteen listeners answering the same
 * press. The listeners attach with the first subscriber and detach with the
 * last, so a cockpit drawing no hints is a cockpit with no listeners.
 *
 * WHAT CLEARS IT, and why each one is here rather than assumed:
 *   - `keyup`, the ordinary release.
 *   - WINDOW BLUR, because ⌘-Tab is a chord whose release the page never sees:
 *     focus leaves on the Tab and the ⌘-up is delivered to whatever you switched
 *     to. Without this the rail would still be wearing its numbers when you came
 *     back, and nothing but another ⌘ press would take them off.
 *   - VISIBILITY, for the same failure by a different route (a hidden tab, the
 *     Mission Control / lock-screen path that does not always blur).
 *
 * AND THE FOCUS RULE: while a text field or a contenteditable holds focus the
 * answer is always false. The composer holds focus nearly all the time in this
 * cockpit, and ⌘C, ⌘V and ⌘A over it are the commonest chords anybody presses —
 * flashing every hint in the window on each of them would make the feature a
 * flicker rather than an affordance. It is the same rule `resolveWebCommandKey-
 * Action` applies, read from the same helper, so the two cannot drift.
 */

import { useSyncExternalStore } from "react";
import { isEditableTarget } from "@/lib/command-keys";
import { keyCapPlatformFor, type KeyCapPlatform } from "@/lib/key-caps";

/** Loosely typed so the fold below runs against a real KeyboardEvent and against
 *  a plain object in a test — the same duck-typing `CommandKeyEventLike` uses. */
export type ModifierEventLike = {
  type?: string | undefined;
  metaKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
};

/**
 * THE WHOLE RULE, AS A FOLD: what the state should be after this event, given
 * what currently holds focus. Pure, so every branch above is testable without a
 * DOM — which is the point of stating it here rather than inside the listeners.
 *
 * `focused` is `document.activeElement`, not `event.target`: a blur carries no
 * useful target at all, and on the release of a chord the two can disagree.
 */
export function modifierHeldAfter(event: ModifierEventLike, platform: KeyCapPlatform, focused: unknown): boolean {
  if (event.type === "blur" || event.type === "visibilitychange") return false;
  if (isEditableTarget(focused)) return false;
  // The platform's own command key, not "either of them": ⌃ on a Mac is a
  // different modifier with its own bindings, and lighting the hints on it would
  // promise chords that are not what the keymap holds.
  return platform === "mac" ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

let held = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (held === next) return;
  held = next;
  for (const listener of listeners) listener();
}

/** Read once and cached: the keyboard does not change under a running window,
 *  and this is consulted on every keydown. */
let platform: KeyCapPlatform | undefined;
function commandModifierPlatform(): KeyCapPlatform {
  platform ??= keyCapPlatformFor(typeof navigator === "undefined" ? "" : `${navigator.userAgent} ${navigator.platform ?? ""}`);
  return platform;
}

function onKey(event: KeyboardEvent) {
  publish(modifierHeldAfter(event, commandModifierPlatform(), document.activeElement));
}
const onLeave = () => publish(false);

/**
 * CAPTURE PHASE, because a surface that stops a keydown from bubbling — the
 * composer's own editor does, for keys it handles — must not also decide
 * whether the rest of the window may draw a hint.
 */
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
    // The next subscriber starts from "not held" rather than from whatever was
    // true when the last hint unmounted.
    held = false;
  };
}

export function modifierHeldSnapshot(): boolean {
  return held;
}

/** The server has no keyboard, so nothing is held and hydration agrees. */
export function serverModifierHeld(): boolean {
  return false;
}

/** True while the platform's command modifier is down and focus is not in a
 *  text field. See the note at the top for everything that clears it. */
export function useModifierHeld(): boolean {
  return useSyncExternalStore(subscribeModifierHeld, modifierHeldSnapshot, serverModifierHeld);
}
