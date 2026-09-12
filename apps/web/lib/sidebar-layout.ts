"use client";

/**
 * Where each project group sits in the rail, and where each ROW sits inside one
 * — the arrangement the reader dragged things into, read from and written to
 * the engine.
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
 *
 * AND IT ARRIVES FROM ELSEWHERE. The arrangement is one document per Mac, so a
 * drop on the phone or in another browser tab changes what THIS rail should be
 * drawing — and until #306 nothing said so, leaving a second device on a copy
 * it would later write back. The engine now carries the whole layout on
 * `/v2/sessions/live`, the read the rail already makes every few seconds, and
 * `observeSidebarLayout` is where the rail hands it back here. No new request,
 * no timer of its own, no second connection.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayout } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

const api = createEngineApi(hostFetcher(LOCAL_HOST_ID));

/** Same-window propagation, carrying what the engine returned. STILL NEEDED
 *  beside the poll: one window can hold several rails (the cockpit's and a
 *  sheet's), and a drop in one must move the others on the same frame rather
 *  than up to ten seconds later. */
const CHANGED = "telar:sidebar-layout";

function announce(layout: SidebarLayout): void {
  window.dispatchEvent(new CustomEvent<SidebarLayout>(CHANGED, { detail: layout }));
}

/** Are two arrangements the same document? Field by field, because the poll
 *  answers several times a minute and a fresh object per pass would re-render
 *  every rail for news it did not carry. */
export function sameSidebarLayout(left: SidebarLayout, right: SidebarLayout): boolean {
  const same = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((key, at) => key === b[at]);
  if (!same(left.projectOrder, right.projectOrder) || !same(left.pinnedOrder, right.pinnedOrder)) return false;
  const groups = left.sessionOrder ?? {};
  const others = right.sessionOrder ?? {};
  const keys = new Set([...Object.keys(groups), ...Object.keys(others)]);
  for (const key of keys) if (!same(groups[key], others[key])) return false;
  return true;
}

/**
 * HOW MANY WRITES ARE IN FLIGHT, module-wide.
 *
 * A poll that started before a drop lands after it, carrying the arrangement
 * from BEFORE the drag — and applying that would put the group back under the
 * pointer, which reads as a drop that missed. So an observed layout is ignored
 * while this rail is mid-write; the write's own answer is authoritative and
 * `announce` delivers it.
 */
let writing = 0;

/**
 * An arrangement read from the engine by somebody else's request — the rail's
 * live-session poll. Applied to every rail in this window, unless a write of
 * our own is in flight (see `writing`).
 */
export function observeSidebarLayout(layout: SidebarLayout | undefined): void {
  if (!layout || writing > 0 || typeof window === "undefined") return;
  announce(layout);
}

export type SidebarLayoutHandle = {
  /** Group keys, top to bottom. Empty until the engine answers — and the rail
   *  reads empty as "alphabetical", so the first paint is a stable one. */
  order: readonly string[];
  /** Session keys per group key, and the pinned band's own. Empty until the
   *  engine answers, which the rail reads as the recency order it always had. */
  sessionOrder: Readonly<Record<string, readonly string[]>>;
  pinnedOrder: readonly string[];
  loading: boolean;
  /** The whole order, as drawn after the drop — see `moveProjectGroup`. */
  setOrder: (next: string[]) => Promise<void>;
  /** ONE GROUP'S ROWS. The field on the wire is the whole map, so this writes
   *  it from the arrangement this window last heard the engine describe —
   *  last write wins, exactly as `setOrder` has always worked. */
  setSessionOrder: (groupKey: string, next: string[]) => Promise<void>;
  setPinnedOrder: (next: string[]) => Promise<void>;
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
      // Unchanged is not news: the poll re-announces the same document several
      // times a minute, and re-setting it would re-render the whole rail.
      if (next && !sameSidebarLayout(next, latest.current)) setLayout(next);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  /**
   * One arrangement, optimistically: the row or group lands where it was
   * dropped on the same frame, the write follows, and an engine that refuses
   * puts it back. THE OPTIMISTIC STATE IS A MERGE, not a replacement — a drop
   * in one group must leave the other two arrangements exactly as they are
   * until the engine answers with all three.
   */
  const patch = useCallback(async (change: Partial<SidebarLayout>) => {
    const previous = latest.current;
    setLayout({ ...previous, ...change });
    writing += 1;
    try {
      // ONE FIELD PER CALL. The engine leaves an absent field alone, so a drop
      // in the pinned band cannot overwrite the groups this same rail arranged
      // a second earlier — which is the whole reason the three are separate
      // fields rather than one document sent whole.
      const result = await api.setSidebarLayout(change as Parameters<typeof api.setSidebarLayout>[0]);
      setLayout(result.layout);
      announce(result.layout);
    } catch {
      // The engine refused or is away: the group goes back where it was. The
      // rail's own "did not answer" line is what says why.
      setLayout(previous);
    } finally {
      writing -= 1;
    }
  }, []);

  const setOrder = useCallback((next: string[]) => patch({ projectOrder: next }), [patch]);
  const setPinnedOrder = useCallback((next: string[]) => patch({ pinnedOrder: next }), [patch]);
  const setSessionOrder = useCallback(
    (groupKey: string, next: string[]) => patch({ sessionOrder: { ...(latest.current.sessionOrder ?? {}), [groupKey]: next } }),
    [patch],
  );

  return {
    order: layout.projectOrder ?? [],
    sessionOrder: layout.sessionOrder ?? {},
    pinnedOrder: layout.pinnedOrder ?? [],
    loading,
    setOrder,
    setSessionOrder,
    setPinnedOrder,
  };
}
