"use client";

// App-wide loom notifier. Mounted ONCE in the root layout so a loom parking
// (needs you) or going ready fires a browser notification from ANY page — the
// dashboard, project pages, settings — not only while a session view is open.
//
// SINGLE FIRING SITE: this is now the ONLY place loom transitions notify.
// session-loom.tsx keeps its visual pill but no longer fires (see report), so a
// notification can never double-fire when a session view is mounted. Cross-tab
// duplicates (the same transition seen by several backgrounded tabs) collapse
// at the OS level via notify.ts's per-kind `tag`, so no extra dedupe is needed.
//
// CLIENT-BUNDLE RULE: only type imports reach @telar/core (erased at compile,
// exactly as app-sidebar.tsx does); the runtime deps are the client-safe
// ui-prefs store + notify helper. Renders nothing.

import { useEffect, useRef } from "react";
import type { Loom, WorkUnitState } from "@telar/core";
import { useUiPrefs } from "@/lib/ui-prefs";
import { notifyLoom } from "@/lib/notify";

// The two urgency tones a transition can fire on (+ the quiet default). Mirrors
// session-view's loomTone: blocked/failed/halted demand the human; ready/
// needs-review/done are the green accept touch-points; everything else weaves.
type Tone = "blocked" | "ready" | "weaving";

function loomTone(s: WorkUnitState): Tone {
  if (s === "blocked" || s === "failed" || s === "halted") return "blocked";
  if (s === "ready" || s === "needs-review" || s === "done") return "ready";
  return "weaving";
}

// Cheap and honest: poll the same list the sidebar already reads. Root looms
// only (bounded), state included — no extra endpoint, no N event streams.
const POLL_MS = 30_000;

export function LoomNotifications() {
  const { notifications } = useUiPrefs();
  // Nothing to fire → zero background work: no fetch, no interval. Master off,
  // or both per-event toggles off, means we never even subscribe.
  const armed =
    notifications.enabled && (notifications.loomParked || notifications.loomReady);

  // loomId → last-seen tone. A fire needs a KNOWN prior tone, so first sight of
  // a loom only seeds — no notification storm when the app (or the poller) opens.
  const prevTones = useRef<Map<string, Tone>>(new Map());

  useEffect(() => {
    if (!armed) {
      // Forget seeds so re-enabling reseeds from the current state (an
      // already-blocked loom present at re-enable must not fire).
      prevTones.current.clear();
      return;
    }

    let cancelled = false;

    const poll = async () => {
      let looms: Loom[];
      try {
        const res = await fetch("/api/looms");
        if (!res.ok) return;
        const data = (await res.json()) as { looms?: unknown };
        looms = Array.isArray(data.looms) ? (data.looms as Loom[]) : [];
      } catch {
        return; // offline / route down — keep prior seeds, try again next tick
      }
      if (cancelled) return;

      const prev = prevTones.current;
      // Same rule as session-loom: never notify about a loom the user is
      // actively watching — only when the tab is hidden or unfocused.
      const backgrounded =
        document.visibilityState === "hidden" || !document.hasFocus();
      const live = new Set<string>();

      for (const l of looms) {
        if (!l || typeof l.id !== "string") continue;
        live.add(l.id);
        const tone = loomTone(l.state);
        const before = prev.get(l.id);
        if (before === tone) continue;
        prev.set(l.id, tone);
        if (before === undefined || !backgrounded) continue; // first sight / watching
        if (tone === "blocked") {
          notifyLoom("loom-parked", {
            title: "Loom needs you",
            body: `${l.title} · ${l.state}`,
            url: `/looms/${l.id}`,
          });
        } else if (tone === "ready") {
          notifyLoom("loom-ready", {
            title: "Loom ready to accept",
            body: l.title,
            url: `/looms/${l.id}`,
          });
        }
      }

      // Drop vanished looms so a later id reuse reseeds cleanly.
      for (const k of [...prev.keys()]) if (!live.has(k)) prev.delete(k);
    };

    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [armed]);

  return null;
}
