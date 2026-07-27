"use client";

import { useCallback, useEffect, useState } from "react";
import type { PendingUltraWake } from "@telar/core";

// Story 4.1 / AC1 — the client half of the completion wake.
//
// Client-side mirror of this session's pending Ultra wakes, fetched from
// /api/ultra/wakes. `import type` is erased at build time, so pulling
// PendingUltraWake from the server-only @telar/core package here carries no
// runtime code — the same erasure `use-accounts.ts` relies on, and the one INV-4
// checks by walking value edges out of every "use client" file.
//
// THE HOUSE CLIENT PATTERN (NFR-X-15), and nothing beyond it: `useState` /
// `useEffect` + `fetch` against the app's own API, refetch on mount, on the
// `window "telar:refresh"` event, and on an interval WHILE SOMETHING RUNS. No
// global store, no EventSource, no new client-state mechanism.
//
// SELF-LIMITING BY CONSTRUCTION. The poll runs only while this session has a
// live run or an undelivered wake; an idle session with no runs settles to
// `{ pending: [], live: 0 }` on mount and then makes no traffic at all. That
// matters more than usual here because the answer costs a directory scan
// server-side (see pendingUltraWakes' own cost note).
//
// WHAT THIS HOOK DOES NOT DO: it does not carry the outcome to the model, and it
// does not decide when a turn may fire. `pending.length` is a TRIGGER; the facts
// travel in the server-composed system-prompt appendix, and the idle gate is
// session-view's existing §6.D drain. Both of those staying out of here is what
// keeps a tampered client unable to make the agent state an outcome that never
// happened, or to POST a second concurrent turn.
const POLL_MS = 4000;

export function useUltraWake(sessionId: string | null) {
  const [pending, setPending] = useState<PendingUltraWake[]>([]);
  const [live, setLive] = useState(0);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setPending([]);
      setLive(0);
      return;
    }
    try {
      const r = await fetch(`/api/ultra/wakes?sessionId=${encodeURIComponent(sessionId)}`);
      if (!r.ok) return;
      const d = await r.json();
      setPending(Array.isArray(d.pending) ? d.pending : []);
      setLive(typeof d.live === "number" ? d.live : 0);
    } catch {
      // best-effort — a failed poll just means the wake lands on the next one,
      // or on the next turn the user starts. The durable mailbox is the
      // guarantee; this is the fast path's fast path.
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The app-wide refresh signal every other client surface listens to, so a
  // manual refresh picks up a run that settled while the tab was backgrounded.
  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [reload]);

  // …and the interval, gated on there being something to wait for.
  const polling = live > 0 || pending.length > 0;
  useEffect(() => {
    if (!sessionId || !polling) return;
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [sessionId, polling, reload]);

  return { pending, live, reload };
}
