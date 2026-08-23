"use client";

/**
 * WHAT YOU HAD ALREADY SEEN — the arrival's diff, with no clock anywhere.
 *
 * ── WHY THIS IS NOT A TIMESTAMP ─────────────────────────────────────────────
 * "What changed since I was last here" sounds like it needs a stamp, and the
 * module forbids one: §3.2's line is that a clock may be read by an AGENT
 * deciding what to do and never by a RENDERER deciding what to draw. Every time
 * label in this store — `captured`, `created`, `settled.at`, `source.pass` — is
 * documented as a display label that nothing sorts or subtracts.
 *
 * `state.ts` already made the same call for `humanActive` and wrote the argument
 * down: "DELIBERATELY NOT 'was there recent activity'. A timestamp threshold
 * would be a clock deciding what the user gets… A live turn is a FACT, not an
 * inference."
 *
 * So this stores no time. It stores the SET OF THINGS YOU HAD SEEN, and the
 * arrival marks whatever is not in it. A set difference is not a clock, it needs
 * no schema change, and it is exactly what a person means by "what's new" —
 * new since *I* looked, not new since some threshold elapsed.
 *
 * ── IT STAYS ON THIS MACHINE, DELIBERATELY ──────────────────────────────────
 * Your reading history is not something the store should hold: it is per-person
 * and per-browser, the engine has no user model, and a "seen" flag on a shared
 * record would let one window mark another window's news as read.
 *
 * ── AND IT ONLY CLEARS WHEN YOU SAY SO ──────────────────────────────────────
 * Not on render. Arriving, glancing at it and opening something else must not
 * silently consume the news — that is the failure every unread badge has, and
 * it is worse here because there is no badge to notice it went.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "telar.spool.seen.v1";

/** Per subject: the threads you had seen, and which of them were already
 *  settled. Two sets rather than one, because a thread you have seen becoming
 *  ANSWERED is the single most useful thing the morning can tell you. */
export type SeenState = Record<string, { threads: string[]; settled: string[] }>;

export type SeenView = {
  /** Absent until the first read resolves — an arrival that marked everything
   *  new on first paint and then un-marked it is a flash of wrong news. */
  seen: SeenState | null;
  isNew: (subject: string, threadId: string) => boolean;
  isNewlySettled: (subject: string, threadId: string) => boolean;
  /** Never used this machine before. The arrival greets rather than announcing
   *  that all nine of your threads are new. */
  firstRun: boolean;
  /** Take the snapshot — the ONLY thing that clears the marks. */
  acknowledge: (current: SeenState) => void;
};

function read(): SeenState | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeenState) : null;
  } catch {
    // A browser with storage denied gets an arrival that marks nothing, which
    // is the honest degradation: no history, so no claims about what is new.
    return null;
  }
}

export function useSpoolSeen(): SeenView {
  const [seen, setSeen] = useState<SeenState | null>(null);
  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    // Deferred to a task, like every other client-only read in this app — a
    // synchronous setState on mount is a cascading render and there is a lint
    // rule about it.
    const task = window.setTimeout(() => {
      const stored = read();
      setFirstRun(stored === null);
      setSeen(stored ?? {});
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const acknowledge = useCallback((current: SeenState) => {
    setSeen(current);
    setFirstRun(false);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Storage full or denied. The marks stay on screen, which is the safe
      // direction: news shown twice beats news lost.
    }
  }, []);

  return {
    seen,
    firstRun,
    // NOTHING IS NEW UNTIL THE HISTORY HAS LOADED, and nothing is new on a
    // machine that has no history — see `firstRun`.
    isNew: (subject, threadId) =>
      seen !== null && !firstRun && !(seen[subject]?.threads ?? []).includes(threadId),
    isNewlySettled: (subject, threadId) =>
      seen !== null && !firstRun && !(seen[subject]?.settled ?? []).includes(threadId),
    acknowledge,
  };
}

/** The snapshot of what is on screen right now, for `acknowledge`. Pure so the
 *  suite can check the shape without a browser. */
export function snapshotOf(
  map: { subjects: Array<{ subject: string; threads: Array<{ thread: { id: string; settled?: unknown } }> }> },
): SeenState {
  const next: SeenState = {};
  for (const subject of map.subjects) {
    next[subject.subject] = {
      threads: subject.threads.map((t) => t.thread.id),
      settled: subject.threads.filter((t) => t.thread.settled).map((t) => t.thread.id),
    };
  }
  return next;
}
