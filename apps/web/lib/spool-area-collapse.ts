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
import { useCallback, useEffect, useState } from "react";

const KEY_PREFIX = "telar:spool-area-collapsed:";

function writeStored(path: string, collapsed: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (collapsed) window.localStorage.setItem(KEY_PREFIX + path, "1");
    else window.localStorage.removeItem(KEY_PREFIX + path);
  } catch {
    // A full or disabled localStorage must not break the tree.
  }
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const next = new Set<string>();
      for (let i = 0; i < window.localStorage.length; i++) {
        const stored = window.localStorage.key(i);
        if (stored?.startsWith(KEY_PREFIX)) next.add(stored.slice(KEY_PREFIX.length));
      }
      if (next.size > 0) setCollapsed(next);
    } catch {
      // Best effort — an unreadable localStorage leaves every container open.
    }
  }, []);

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const willCollapse = !next.has(path);
      if (willCollapse) next.add(path);
      else next.delete(path);
      writeStored(path, willCollapse);
      return next;
    });
  }, []);

  const isCollapsed = useCallback((path: string) => collapsed.has(path), [collapsed]);

  const collapseOthers = useCallback((keep: string, allPaths: string[]) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const path of allPaths) {
        // `keep` itself, and every ancestor on its own path (the " / "
        // prefix convention `lib/spool-area-tree.ts` splits on), stay open —
        // collapsing an ancestor would fold `keep` away with everything else.
        const isKeptOrAncestor = path === keep || keep.startsWith(path + " / ");
        if (isKeptOrAncestor) {
          if (next.delete(path)) writeStored(path, false);
        } else if (!next.has(path)) {
          next.add(path);
          writeStored(path, true);
        }
      }
      return next;
    });
  }, []);

  return { isCollapsed, toggle, collapseOthers };
}
