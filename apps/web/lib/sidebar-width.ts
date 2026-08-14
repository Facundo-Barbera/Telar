"use client";

// The arithmetic of a draggable sidebar, and the little store that remembers
// the result. Both halves live here for the same reason ui-prefs.ts is one
// file: they are one concern — how wide this sidebar is and whether it is
// folded away — and splitting them would put a two-field record in one module
// and the rules that validate it in another.
//
// WHY THE NUMBERS ARE PURE FUNCTIONS. The drag itself is imperative by
// necessity: it runs inside requestAnimationFrame and writes a CSS variable
// straight to the DOM, because a re-render per pointermove is sixty re-renders
// a second for a value only CSS reads. That makes the drag untestable without
// a browser — so everything that DECIDES a width (clamping, and whether a
// proposed width is allowed at all) is lifted out into functions that take
// numbers and return numbers. What is left in the component is bookkeeping.
//
// WHY THE STORE IS A PLAIN EXTERNAL STORE. Same answer as ui-prefs.ts, and the
// same reason: there is no zustand in this app, and none is wanted. subscribe +
// snapshot + useSyncExternalStore is the whole mechanism.
//
// WHY THE SERVER SNAPSHOT IS EMPTY, which is the part worth reading twice.
// localStorage does not exist during the server render, so a persisted width is
// simply not knowable when the HTML is produced. React uses `getServerSnapshot`
// for the SSR render AND for the hydration render, then re-renders with
// `getSnapshot` — so both sides agree on "nothing stored", the sidebar hydrates
// at its default width, and the remembered width arrives in the commit after.
// The alternative — reading localStorage during render — makes the server say
// 16rem and the client say 320px for the same element, which is the textbook
// hydration mismatch. use-hydrated.ts explains at length why the other tempting
// answer, suppressHydrationWarning, is worse than the bug.

import { useCallback, useSyncExternalStore } from "react";

// The floor a resizable sidebar falls back to when a caller names no minimum:
// 16rem, the same width SIDEBAR_WIDTH has always used, so opting into resizing
// never moves the sidebar on its own.
export const SIDEBAR_RESIZE_MIN_WIDTH = 16 * 16;
export const APP_SIDEBAR_MAIN_MIN_WIDTH = 640;
export const APP_SIDEBAR_STORAGE_KEY = "app";

const KEY_PREFIX = "telar-sidebar:";

export type SidebarPrefs = {
  width: number | null;
  collapsed: boolean | null;
};

// One shared instance for "nothing remembered". Identity matters here rather
// than being a micro-optimisation: useSyncExternalStore compares snapshots by
// reference and re-renders until two agree, so a getSnapshot that minted a
// fresh `{ width: null, collapsed: null }` on every call would spin forever.
export const NO_SIDEBAR_PREFS: SidebarPrefs = { width: null, collapsed: null };

// ── the pure half ───────────────────────────────────────────────────────────

// Keep a width inside its bounds. `Math.max` is outermost deliberately: when
// the window is narrower than the minimum the caller asked for, `maxWidth` ends
// up BELOW `minWidth`, and in that degenerate case the minimum has to win or a
// sidebar on a small screen collapses to nothing. A NaN — the shape a corrupt
// stored value would take if it got this far — reads as "no usable width" and
// also lands on the minimum, because `NaN + "px"` is not a length and the
// browser would silently drop the declaration.
export function clampSidebarWidth(width: number, minWidth: number, maxWidth: number): number {
  if (Number.isNaN(width)) return minWidth;
  return Math.max(minWidth, Math.min(width, maxWidth));
}

// One step of a drag: the pointer proposes a width, the bounds trim it, and an
// optional predicate gets the last word. A refusal is not an error and not a
// stop — it returns the width the sidebar already has, so the pointer keeps
// tracking and the very next frame that proposes something acceptable takes
// effect. That is what makes a sidebar dragged past its limit draggable BACK
// rather than stuck against it.
export function resolveDragWidth(
  currentWidth: number,
  proposedWidth: number,
  minWidth: number,
  maxWidth: number,
  accept?: (nextWidth: number) => boolean,
): number {
  const nextWidth = clampSidebarWidth(proposedWidth, minWidth, maxWidth);
  if (accept && !accept(nextWidth)) return currentWidth;
  return nextWidth;
}

// Flush the latest pointer proposal through the same rules used by a painted
// animation frame. Pointer-up can arrive before requestAnimationFrame; keeping
// this operation explicit lets release commit the actual final pointer position
// instead of the previous frame's width.
export function flushPendingSidebarWidth(
  currentWidth: number,
  pendingWidth: number,
  minWidth: number,
  maxWidth: number,
  accept?: (nextWidth: number) => boolean,
): number {
  return resolveDragWidth(currentWidth, pendingWidth, minWidth, maxWidth, accept);
}

// The predicate most callers want: the sidebar may not grow into the space the
// main pane needs. Stated as two clauses because the second one alone would be
// a trap — a sidebar that is already too wide (the window was resized, or the
// caller lowered the floor) would fail the room check at every width and could
// never be dragged back. Shrinking is therefore always allowed, whatever the
// numbers say.
//
// AppSidebar is the first consumer: its rail uses this with a 640px main-pane
// floor. Keep the two clauses and the mounted contract tests in sync if that
// geometry changes; a green pure-function suite alone is not evidence that the
// production rail still uses the rule.
export function keepsRoomForMain(
  currentWidth: number,
  nextWidth: number,
  availableWidth: number,
  mainMinWidth: number,
): boolean {
  return nextWidth <= currentWidth || availableWidth - nextWidth >= mainMinWidth;
}

// Merge a persisted payload over "nothing remembered", dropping anything that
// is not usable as-is. A width has to be a finite positive number — a stale
// key, a hand-edit, a `null` left by JSON.stringify(Infinity) all read as
// absent, and absent means the sidebar renders its default rather than
// inheriting a broken length. Returning the shared empty record when nothing
// survives keeps the snapshot referentially stable; see NO_SIDEBAR_PREFS.
export function sanitizeSidebarPrefs(raw: unknown): SidebarPrefs {
  if (!raw || typeof raw !== "object") return NO_SIDEBAR_PREFS;
  const r = raw as Record<string, unknown>;
  const width =
    typeof r.width === "number" && Number.isFinite(r.width) && r.width > 0 ? r.width : null;
  const collapsed = typeof r.collapsed === "boolean" ? r.collapsed : null;
  if (width === null && collapsed === null) return NO_SIDEBAR_PREFS;
  return { width, collapsed };
}

export function parseSidebarPrefs(raw: string | null): SidebarPrefs {
  if (!raw) return NO_SIDEBAR_PREFS;
  try {
    return sanitizeSidebarPrefs(JSON.parse(raw));
  } catch {
    return NO_SIDEBAR_PREFS;
  }
}

// ── the store ───────────────────────────────────────────────────────────────

// Keyed by SURFACE name ("app", "gallery"), not by raw storage key: the prefix
// lives here so cross-tab filtering is one startsWith and no caller has to know
// the on-disk spelling.
const cache = new Map<string, SidebarPrefs>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Hydrated lazily on first client read, so the module is inert when imported on
// the server or under a test runner with no DOM.
export function getSidebarPrefs(key: string | null): SidebarPrefs {
  if (!key || typeof window === "undefined") return NO_SIDEBAR_PREFS;
  const hit = cache.get(key);
  if (hit) return hit;
  let parsed: SidebarPrefs;
  try {
    parsed = parseSidebarPrefs(window.localStorage.getItem(KEY_PREFIX + key));
  } catch {
    parsed = NO_SIDEBAR_PREFS;
  }
  cache.set(key, parsed);
  return parsed;
}

function write(key: string, next: SidebarPrefs) {
  cache.set(key, next);
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(next));
  } catch {
    /* private mode / storage blocked — the size just isn't remembered */
  }
  emit();
}

export function setSidebarWidth(key: string, width: number) {
  write(key, { ...getSidebarPrefs(key), width });
}

export function setSidebarCollapsed(key: string, collapsed: boolean) {
  write(key, { ...getSidebarPrefs(key), collapsed });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Cross-tab sync: another tab resizing or folding the same surface updates this
// tab's snapshot. Same convention as ui-prefs.ts.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(KEY_PREFIX)) return;
    cache.set(e.key.slice(KEY_PREFIX.length), parseSidebarPrefs(e.newValue));
    emit();
  });
}

const getServerPrefs = () => NO_SIDEBAR_PREFS;

export function useSidebarPrefs(key: string | null): SidebarPrefs {
  // getSnapshot has to be stable across renders or useSyncExternalStore
  // resubscribes on every one; the key is a string, so this closure changes
  // only when the surface does.
  const getSnapshot = useCallback(() => getSidebarPrefs(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerPrefs);
}
