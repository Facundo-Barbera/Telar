"use client";

/**
 * A CONTAINER'S FOLD STATE — `docs/spool-loops.md` §13.7: every area-path
 * node is "collapsible", in both the rail's tree and the lobby's. Keyed by
 * the node's own joined path, so "Work" and "Work / Focaltec" persist
 * independently of one another.
 *
 * A UI PREFERENCE, NOT A FACT THE STORE OWNS — it lives in `localStorage`
 * the same way `lib/right-panel-tabs.ts` and `lib/sidebar-width.ts` already
 * persist per-browser layout choices, never a second field the engine
 * tracks. Read after mount, like every other `localStorage`-backed
 * preference in this app: the key does not exist during the server render,
 * so seeding `useState` from it would desync hydration.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY_PREFIX = "telar:spool-area-collapsed:";

/** READ THROUGH `useSyncExternalStore`, NOT A MOUNT EFFECT. This was
 *  `useState(new Set())` plus an effect that called `setCollapsed` once
 *  `localStorage` had been scanned — a second render pass on every mount,
 *  which the React compiler flags as a cascading render. The stored keys ARE
 *  an external store, so they are read as one, with a separate server snapshot
 *  for the render that has no `localStorage` at all.
 *
 *  THE SNAPSHOT IS CACHED because `getSnapshot` must return a stable value
 *  until something changes: rebuilding the Set on every call would hand React
 *  a new identity each time and spin. `writeStored` invalidates it, which is
 *  also what makes the rail's tree and the lobby's agree — they used to hold
 *  one independent copy of this state each. */
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();
let cached: ReadonlySet<string> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlySet<string> {
  if (cached) return cached;
  const next = new Set<string>();
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const stored = window.localStorage.key(i);
      if (stored?.startsWith(KEY_PREFIX)) next.add(stored.slice(KEY_PREFIX.length));
    }
  } catch {
    // Best effort — an unreadable localStorage leaves every container open.
  }
  cached = next;
  return cached;
}

function writeStored(path: string, collapsed: boolean) {
  if (typeof window === "undefined") return;
  const next = new Set(snapshot());
  if (collapsed) next.add(path);
  else next.delete(path);
  cached = next;
  try {
    if (collapsed) window.localStorage.setItem(KEY_PREFIX + path, "1");
    else window.localStorage.removeItem(KEY_PREFIX + path);
  } catch {
    // A full or disabled localStorage must not break the tree — the fold still
    // holds for this session, it just will not survive a reload.
  }
}

function notify() {
  for (const listener of listeners) listener();
}

export function useAreaCollapse(): {
  isCollapsed: (path: string) => boolean;
  toggle: (path: string) => void;
  /** COLLAPSE OTHERS — the rail's own context-menu verb. Given every known
   *  node path, collapses everything except `keep` (and `keep`'s own
   *  ancestors, so the kept node stays visible rather than folding itself
   *  shut by folding its parent). Still nothing but this module's own
   *  `toggle`/`writeStored` shape, looped — no second collapse mechanism. */
  collapseOthers: (keep: string, allPaths: string[]) => void;
} {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => EMPTY);

  const toggle = useCallback((path: string) => {
    writeStored(path, !snapshot().has(path));
    notify();
  }, []);

  const isCollapsed = useCallback((path: string) => collapsed.has(path), [collapsed]);

  const collapseOthers = useCallback((keep: string, allPaths: string[]) => {
    for (const path of allPaths) {
      // `keep` itself, and every ancestor on its own path (the " / "
      // prefix convention `lib/spool-area-tree.ts` splits on), stay open —
      // collapsing an ancestor would fold `keep` away with everything else.
      const isKeptOrAncestor = path === keep || keep.startsWith(path + " / ");
      if (isKeptOrAncestor) {
        if (snapshot().has(path)) writeStored(path, false);
      } else if (!snapshot().has(path)) {
        writeStored(path, true);
      }
    }
    notify();
  }, []);

  return { isCollapsed, toggle, collapseOthers };
}
