"use client";

import { useEffect, useRef } from "react";

export type PollOptions = {
  /** Run once on mount instead of waiting a full period. Default true. */
  immediate?: boolean;
  /** Restart the poll (aborting the read in flight) when this changes. */
  key?: unknown;
};

/**
 * Calls `fn` every `ms`, never overlapping a read still in flight. `null` stops it.
 * Ticks are skipped while the document is hidden, and one runs as soon as it shows again.
 * `fn` gets a signal aborted on unmount and on `key` change; it handles its own errors.
 */
export function usePoll(fn: (signal: AbortSignal) => unknown, ms: number | null, { immediate = true, key }: PollOptions = {}): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    if (ms === null) return;
    const controller = new AbortController();
    let running = false;
    const run = () => {
      if (running || controller.signal.aborted || document.visibilityState === "hidden") return;
      const result = latest.current(controller.signal);
      if (!(result instanceof Promise)) return;
      running = true;
      const done = () => {
        running = false;
      };
      result.then(done, done);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };
    if (immediate) run();
    const timer = window.setInterval(() => run(), ms);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, key, immediate]);
}
