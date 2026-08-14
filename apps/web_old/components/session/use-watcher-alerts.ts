"use client";

// WATCHER ALERTS — the cards that tell the HUMAN a watched loom reached a
// trigger state (docs/watchers-design.md §6). Nothing here reaches the model.
//
// THIS HOOK USED TO AUTHOR TURNS, and that is the history worth keeping. It held
// both machinery producers — the loom watcher's "[watcher] …" turn and story
// 4.1's hidden Ultra completion-wake — plus the single idleness gate (§6.D) that
// dispatched them through send(). All of it was client-authored, so a trigger
// existed only while a tab was MOUNTED: an Ultra run that settled overnight woke
// nobody, a watched loom that finished with the tab closed was never spoken
// about, and a remount reset the in-memory latches (an announced-runs Set, a
// lastFired Map) that were their only dedupe. In docs/session-context-integrity.md's
// terms that is failure direction 1 — the outcome is durably recorded and
// rendered, and the model is never told, because the appendix (the durable door)
// only delivers on a turn that fires.
//
// Both producers are now SERVER-authored tickets in the durable session queue:
// `scanSessionMachinery` in lib/server/session-engine.ts, keyed per event so one
// terminal event yields at most one ticket, drained by the engine whether or not
// anything is mounted. Do not re-add a producer here — a second author for the
// same event is a second dedupe rule, and only the ticket key can be the one.
//
// What stays is the alert SURFACE: a dismissible card, ephemeral by nature, for
// a reader who is looking at this session right now.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Watch, WorkUnitState } from "@telar/core";
import { cachedJson } from "@/lib/client-json-cache";
import { acquireSharedEventSource } from "@/lib/shared-event-source";

export type WatcherAlert = {
  id: string;
  loomId: string;
  title: string;
  state: WorkUnitState;
};

export function useWatcherAlerts({
  sessionId,
  status,
}: {
  sessionId: string | null;
  status: string;
}) {
  // Active watches for THIS session, seeded from the server on mount and after
  // each turn (loadWatches). watchesRef mirrors it so the background
  // subscriber's handlers read the LATEST triggerStates without `watches` being
  // in the effect's dep set — which would re-subscribe on every edit rather than
  // only when the watched-loom set changes.
  const [watches, setWatches] = useState<Watch[]>([]);
  const watchesRef = useRef<Watch[]>(watches);
  // Mirrored in an effect rather than assigned during render: the only readers
  // are EventSource handlers, which cannot run before the commit that this
  // effect follows, so "latest committed watches" is exactly what they need.
  useEffect(() => {
    watchesRef.current = watches;
  }, [watches]);

  // Fired alerts surfaced as cards near the loom-handoff banner.
  const [watcherAlerts, setWatcherAlerts] = useState<WatcherAlert[]>([]);

  // De-dupe for the CARDS ONLY: watchId -> the last trigger state a card was
  // shown for. A ref, so it survives re-subscribes and a connect-time `run`
  // snapshot of an already-shown state can't re-show; re-arms only when the loom
  // reaches a DIFFERENT trigger state. The TURN's dedupe is no longer this — it
  // is the ticket key `watch:<watchId>:<state>` — so a card this tab never got
  // to show no longer means a turn nobody ever ran.
  const lastShownRef = useRef<Map<string, WorkUnitState>>(new Map());
  // Monotonic id source for alert items.
  const seqRef = useRef(0);

  // Stable, sorted, comma-joined set of watched loomIds. The background
  // subscriber keys on THIS primitive so it re-subscribes only when the SET
  // changes — never on every render or an unrelated `watches` field edit.
  const watchedLoomIds = Array.from(new Set(watches.map((w) => w.loomId)))
    .sort()
    .join(",");

  // §6.B — load this session's active watches on mount (sessionId set) AND after
  // each turn completes (status → "ready"), so a watch the agent just registered
  // via watch_loom is picked up without a reload. Gated on "ready" so it never
  // refetches mid-turn; the fresh-session case (sessionId null until the first
  // turn's "session" event) is covered when that turn lands back on "ready".
  useEffect(() => {
    if (!sessionId || status !== "ready") return;
    let cancelled = false;
    cachedJson<Watch[] | { watches?: Watch[] }>(
      `/api/chat/${encodeURIComponent(sessionId)}/watches`,
      { force: true },
    )
      .then((data) => {
        if (cancelled) return;
        setWatches(Array.isArray(data) ? data : Array.isArray(data?.watches) ? data.watches : []);
      })
      .catch(() => {
        // Route not ready / offline — keep whatever we already have.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, status]);

  // §6.C — background subscriber, UNGATED on status/idle: it must react while
  // the user keeps chatting and while a turn is in flight. Keyed on the stable
  // watchedLoomIds string, one EventSource per watched loom; the connect-time
  // `run` snapshot also catches a state change missed while the tab was closed.
  useEffect(() => {
    const loomIds = watchedLoomIds ? watchedLoomIds.split(",") : [];
    if (loomIds.length === 0) return;
    const sources = loomIds.map((loomId) => {
      // SHARED, not owned (issue #82): when this session both IS a loom and
      // WATCHES it, the handoff hook holds the same URL — one socket serves
      // both instead of the measured duplicate.
      const { source: es, release } = acquireSharedEventSource(
        `/api/looms/${encodeURIComponent(loomId)}/events`,
      );
      const onRun = (e: Event) => {
        let loom: { state?: WorkUnitState; title?: unknown };
        try {
          loom = JSON.parse((e as MessageEvent).data);
        } catch {
          return;
        }
        const state = loom?.state;
        if (!state) return;
        // Read the live watch from the ref, not a stale closure — triggerStates
        // can change without the watched-loom SET (this effect's dep) changing.
        const watch = watchesRef.current.find(
          (w) => w.loomId === loomId && w.status === "active",
        );
        if (!watch || !watch.triggerStates.includes(state)) return;
        // Show once per (watch, state); re-arm only on a DIFFERENT trigger state.
        if (lastShownRef.current.get(watch.id) === state) return;
        lastShownRef.current.set(watch.id, state);
        const title = typeof loom.title === "string" && loom.title ? loom.title : loomId;
        const seq = seqRef.current++;
        setWatcherAlerts((prev) => [...prev, { id: `wa${seq}`, loomId, title, state }]);
      };
      es.addEventListener("run", onRun as EventListener);
      // No "end" close here: the registry owns the terminal close and the
      // auto-reconnect churn guard with it (a consumer closing a shared
      // socket would sever the handoff hook's subscription to the same loom).
      return { es, onRun, release };
    });
    // CRITICAL: detach EVERY listener and release EVERY hold on unmount or
    // when the watched-loom SET changes — no leaks, no double-subscribe. The
    // socket itself closes only when its LAST subscriber releases.
    return () => {
      for (const { es, onRun, release } of sources) {
        es.removeEventListener("run", onRun as EventListener);
        release();
      }
    };
  }, [watchedLoomIds]);

  const dismissAlert = useCallback(
    (id: string) => setWatcherAlerts((prev) => prev.filter((x) => x.id !== id)),
    [],
  );

  return { watcherAlerts, dismissAlert };
}
