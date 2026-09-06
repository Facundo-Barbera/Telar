"use client";

/**
 * Where each project group sits in the rail — the arrangement the reader
 * dragged the groups into, read from and written to the engine.
 *
 * ENGINE STATE, NOT LOCAL STORAGE, for the reason `inbox-policy.ts` gives: the
 * same rail is drawn by the desktop shell, a browser tab and a paired phone,
 * and an arrangement kept per window would be one you had to redo in each.
 * (The FOLD state of each group stays in localStorage — see `useCollapsedGroups`
 * — because which groups you have open is about the window you are in, the way
 * theme is. Where they sit is about the work.)
 *
 * THIS COCKPIT'S ENGINE, WHATEVER THE ADDRESS BAR SAYS. The default fetcher
 * follows the pathname, so a screen under `/hosts/:id/…` would read a paired
 * Mac's document — but the keys in this one are minted by the cockpit that
 * drew the rail (a remote group is `hostId:projectId`, and the host id is this
 * cockpit's), so only this cockpit's engine can hold an arrangement of them.
 *
 * OPTIMISTIC. The group lands where it was dropped on the same frame, and the
 * write follows; an engine that refuses puts it back. A drag that waited for a
 * round trip before the group moved would read as a drop that missed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayout } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

const api = createEngineApi(hostFetcher(LOCAL_HOST_ID));

/** Same-window propagation, carrying what the engine returned. */
const CHANGED = "telar:sidebar-layout";

function announce(layout: SidebarLayout): void {
  window.dispatchEvent(new CustomEvent<SidebarLayout>(CHANGED, { detail: layout }));
}

export type SidebarLayoutHandle = {
  /** Group keys, top to bottom. Empty until the engine answers — and the rail
   *  reads empty as "alphabetical", so the first paint is a stable one. */
  order: readonly string[];
  loading: boolean;
  /** The whole order, as drawn after the drop — see `moveProjectGroup`. */
  setOrder: (next: string[]) => Promise<void>;
};

export function useSidebarLayout(): SidebarLayoutHandle {
  const [layout, setLayout] = useState<SidebarLayout>(DEFAULT_SIDEBAR_LAYOUT);
  const [loading, setLoading] = useState(true);
  // What is on screen right now, for the revert — read at call time rather than
  // closed over, so two quick drags do not put back the state from before the
  // first one.
  const latest = useRef<SidebarLayout>(DEFAULT_SIDEBAR_LAYOUT);
  useEffect(() => {
    latest.current = layout;
  });

  useEffect(() => {
    const task = window.setTimeout(() => {
      void api
        .sidebarLayout()
        .then((result) => setLayout(result.layout))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<SidebarLayout>).detail;
      if (next) setLayout(next);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const setOrder = useCallback(async (next: string[]) => {
    const previous = latest.current;
    setLayout({ projectOrder: next });
    try {
      const result = await api.setSidebarLayout({ projectOrder: next });
      setLayout(result.layout);
      announce(result.layout);
    } catch {
      // The engine refused or is away: the group goes back where it was. The
      // rail's own "did not answer" line is what says why.
      setLayout(previous);
    }
  }, []);

  return { order: layout.projectOrder, loading, setOrder };
}
