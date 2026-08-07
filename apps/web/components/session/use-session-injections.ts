"use client";

// SYNTHETIC TURNS — turns this session dispatches on its own, without the human
// typing. Two producers today: a loom watcher whose watched loom reached a
// trigger state (docs/watchers-design.md §6), and story 4.1's Ultra
// completion-wake. One consumer: the §6.D drain, which dispatches exactly one
// queued turn once the composer is genuinely idle.
//
// The three live together because they share one queue and one id source, and
// because the drain's idleness gate is the single thing standing between
// "an assistant turn appears on its own" and "two turns fire at once". Writing
// a second idleness predicate somewhere else is how that guarantee is lost, so
// there is exactly one, here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Watch, WorkUnitState } from "@telar/core";
import { cachedJson } from "@/lib/client-json-cache";
import type { PendingUltraWake } from "@telar/core";
import {
  freshUltraWakes,
  shouldEnqueueUltraWake,
  ULTRA_WAKE_SENTINEL,
} from "@/lib/ultra-wake";

export type WatcherAlert = {
  id: string;
  loomId: string;
  title: string;
  state: WorkUnitState;
};

export function useSessionInjections({
  sessionId,
  status,
  reconnectLive,
  pendingWakes,
  abortRef,
  reconnectAbortRef,
  send,
}: {
  sessionId: string | null;
  status: string;
  /** Wakes the drain when the reconnect tail clears without a status change. */
  reconnectLive: boolean;
  pendingWakes: PendingUltraWake[];
  abortRef: React.RefObject<AbortController | null>;
  reconnectAbortRef: React.RefObject<AbortController | null>;
  send: (text: string, opts?: { hidden?: boolean }) => void | Promise<void>;
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

  // Synthetic turns waiting for the composer to go idle before they dispatch
  // through send() (never mid-turn — the busy guard forbids it).
  //
  // `hidden` IS NOT OPTIONAL MACHINERY. Without it the drain would call
  // `send(next.text)` with no options object, `send`'s `opts?.hidden` would read
  // falsy, and its `...(opts?.hidden ? [] : [{ role: "user", … }])` spread would
  // push a real user bubble — rendering the raw wake sentinel as something the
  // human appeared to type. The watcher sets no flag, so its own "[watcher] …"
  // turns stay VISIBLE, which is what they are meant to be.
  const [injectionQueue, setInjectionQueue] = useState<
    { id: string; text: string; hidden?: boolean }[]
  >([]);

  // De-dupe: watchId -> last trigger state we fired on. A ref, so it survives
  // re-subscribes and a connect-time `run` snapshot of an already-fired state
  // can't re-fire; re-arms only when the loom reaches a DIFFERENT trigger state.
  const lastFiredRef = useRef<Map<string, WorkUnitState>>(new Map());
  // Monotonic id source for alert / injection items.
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
      const es = new EventSource(`/api/looms/${encodeURIComponent(loomId)}/events`);
      es.addEventListener("run", (e) => {
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
        // Fire once per (watch, state); re-arm only on a DIFFERENT trigger state.
        if (lastFiredRef.current.get(watch.id) === state) return;
        lastFiredRef.current.set(watch.id, state);
        const title = typeof loom.title === "string" && loom.title ? loom.title : loomId;
        const seq = seqRef.current++;
        setWatcherAlerts((prev) => [...prev, { id: `wa${seq}`, loomId, title, state }]);
        setInjectionQueue((q) => [
          ...q,
          {
            id: `wi${seq}`,
            text: `[watcher] loom ${loomId} (${title}) reached ${state}. How do you want to proceed?`,
          },
        ]);
      });
      // A terminal loom sends `end` then closes; stop EventSource's auto-reconnect
      // so a done/failed/needs-review loom doesn't churn re-opening the stream.
      es.addEventListener("end", () => es.close());
      return es;
    });
    // CRITICAL: close EVERY source on unmount or when the watched-loom SET
    // changes — no leaks, no double-subscribe.
    return () => {
      for (const es of sources) es.close();
    };
  }, [watchedLoomIds]);

  // Story 4.1 — an Ultra run that finished while this session was idle becomes
  // one hidden trigger turn.
  //
  // ONE TRIGGER PER PASS, however many runs finished (T10). The appendix carries
  // all of them — its formatter takes a list — so three finished runs must not
  // fire three turns. The wakes stay pending until the ROUTE acks them (which it
  // does on the turn that consumes them), so without a latch every poll in that
  // window would enqueue again.
  //
  // THE LATCH IS THE SET OF RUNS ALREADY ANNOUNCED, NOT A BOOLEAN (review SF-1).
  // It was a boolean cleared only by `pendingWakes.length === 0`, and that has a
  // reachable hole: several runs can be live for one session (§5.6-T10's own
  // premise, and `packages/core/src/ultra/executor.ts`'s `RUN_CONCURRENCY = 3`
  // is what bounds it), so run A settles and its wake turn streams for 30s, run B
  // settles a second later, and every subsequent poll returns a NON-empty
  // mailbox — so the latch never cleared, B was never enqueued, and when the
  // session went idle no unprompted turn ever appeared for it. AC1's
  // Given/When/Then was simply unmet for the second run.
  //
  // Keying on the run-ids themselves fixes it without re-opening T10: a poll
  // enqueues exactly one trigger if it carries any run this component has not
  // announced yet, however many that is. Pruning to the currently-pending set is
  // what re-arms a RESUMED run — `deliveredTerminalAt` makes it pending again
  // under the same id, and it must be announceable again — while a run that is
  // merely still-unacked stays in the set and cannot re-fire.
  //
  // NOTE the deliberate non-re-arm: if the wake turn DIES before the route acks
  // (the SDK binary missing, a mid-stream abort), the run stays pending and
  // stays announced, so no second trigger fires for it. That is the old
  // behaviour preserved on purpose — a permanently failing turn must not become
  // a turn loop — and the outcome still reaches the model on the next turn the
  // human starts, which is AC2's path and needs no trigger at all.
  //
  // The decision itself is `freshUltraWakes` in lib/ultra-wake.ts — pure, and
  // out of this file precisely so a test can drive it. All this ref holds is the
  // carry-over between polls.
  //
  // BOTH HALVES OF T10 ARE IN THE SEAM, not here — `freshUltraWakes` decides
  // WHICH runs are new, `shouldEnqueueUltraWake` decides whether a trigger may
  // be added given what is already queued. Read that second one's header before
  // touching this: dropping it re-opens exactly what T10 forbids, and it is
  // asked inside the updater so it sees the real queue rather than a render-time
  // closure over it. (`seq` is simply not consumed on the skip path; it is an id
  // source, and a gap in it means nothing.)
  const announcedWakesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const { fresh, announced } = freshUltraWakes(
      announcedWakesRef.current,
      pendingWakes.map((w) => w.runId),
    );
    announcedWakesRef.current = announced;
    if (fresh.length === 0) return;
    const seq = seqRef.current++;
    setInjectionQueue((q) =>
      shouldEnqueueUltraWake(fresh, q)
        ? [
            ...q,
            // The SENTINEL, never the outcome text. route.ts swaps it for the
            // server-authored instruction and the system-prompt appendix carries
            // the facts, so this client authors the trigger and nothing else.
            // `hidden` suppresses the local bubble; the route's `hideUserMessage`
            // is what keeps it out of the persisted transcript (they are two
            // different suppressions, and a wake needs both).
            { id: `uw${seq}`, text: ULTRA_WAKE_SENTINEL, hidden: true },
          ]
        : q,
    );
  }, [pendingWakes]);

  // §6.D — when the composer is idle ("ready" — mid-turn is forbidden by the
  // busy guard) and a synthetic turn is queued, dequeue exactly ONE and dispatch
  // it via the normal send() path. Removing the item BEFORE send() (which
  // synchronously flips status to "submitted") plus this status gate guarantees
  // no double-injection / infinite loop: the queue shrinks each pass and the
  // next item can only fire once the turn settles back to "ready".
  //
  // Also require no active reader: during the §1b reconnect tail status is
  // transiently "ready" while a detached turn still runs server-side (the
  // reconnect effect only flips to "streaming" on its first live event), so
  // injecting then would POST a second concurrent turn — the mid-turn injection
  // the busy guard forbids. abortRef/reconnectAbortRef being null means truly idle.
  useEffect(() => {
    if (
      status !== "ready" ||
      abortRef.current ||
      reconnectAbortRef.current ||
      injectionQueue.length === 0
    )
      return;
    const [next, ...rest] = injectionQueue;
    setInjectionQueue(rest);
    // A WAKE TRIGGER IS ONLY VALID WHILE THE MAILBOX IT SPEAKS FOR IS STILL FULL
    // (review SF-2). Nothing else re-validates it: the server's
    // `isUltraWakeTrigger` is `!!sessionId && message === ULTRA_WAKE_SENTINEL`
    // and consults no state. So a trigger enqueued while the drain was blocked
    // and dispatched after the wakes were already acked would run
    // ULTRA_WAKE_PROMPT — "the COMPLETED ULTRA RUNS block in your context above
    // carries each run's outcome" — against a prompt with no such block, on a
    // turn that renders no user bubble. The reachable path is the §1b reconnect
    // tail: `status` is transiently "ready" while `reconnectAbortRef.current` is
    // non-null, so the composer is enabled and the drain is not; the human types;
    // that POST acks and renders the wakes; the tail clears and this drains the
    // stale trigger. Dropping it here (already removed from the queue above) is
    // the whole fix. The sentinel IS the discriminator — the same seam the route
    // recognizes on — so no second flag has to be kept in sync with it.
    if (next.text === ULTRA_WAKE_SENTINEL && pendingWakes.length === 0) return;
    // The three conditions above are untouched and must stay that way. The flag
    // is threaded through so a hidden item (the Ultra wake trigger) reaches
    // send()'s `hidden` branch and renders no user bubble, while an unflagged
    // item (the loom watcher) dispatches exactly as before.
    void send(next.text, next.hidden ? { hidden: true } : undefined);
    // `reconnectLive` is a dependency because this gate reads `reconnectAbortRef`,
    // so it also needs waking when that ref clears without a status change.
  }, [status, injectionQueue, send, pendingWakes, reconnectLive, abortRef, reconnectAbortRef]);

  const dismissAlert = useCallback(
    (id: string) => setWatcherAlerts((prev) => prev.filter((x) => x.id !== id)),
    [],
  );

  return { watcherAlerts, dismissAlert };
}
