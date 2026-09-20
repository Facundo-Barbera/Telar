"use client";

/**
 * WHAT THIS APP'S PROCESSES ARE DOING, as the cockpit sees it — issue #488.
 *
 * TWO WAYS IN, AND THE ORDER MATTERS. Inside the desktop shell a window asks
 * the main process directly over the preload bridge: one hop, no HTTP, and it
 * keeps working when the cockpit's own server is the thing that is wedged.
 * Everywhere else — a phone, a second browser, the remote host — there is no
 * bridge, and `/api/desktop/metrics` proxies to the shell's loopback control
 * server instead. Same figures, same shape, and the caller does not choose.
 *
 * A LOCAL STRUCTURAL TYPE AND AN ACCESSOR, the shape `desktop-store.ts` and
 * `desktop-updates.ts` use, for the same reason: a global `Window`
 * augmentation would imply the bridge is always there, and in a browser tab it
 * never is.
 *
 * NOTHING HERE TALKS TO THE ENGINE. These are the SHELL's processes — the main
 * process, the GPU, the renderers, the utility children. The engine is one
 * forked sibling among them and its own CPU is a separate question (#457).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ProcessTypeTotal = {
  /** Electron's own `ProcessMetric.type`. */
  type: string;
  /** That type in a sentence a person reads — "Renderer", not "Tab". */
  label: string;
  count: number;
  /** Percent of ONE core, so a machine with eight can report 800. */
  cpuPercent: number;
  memoryKb: number;
  /** Renderers in this bucket hosting no page anybody can see. Zero for every
   *  type that is not a renderer, and zero when the shell could not read which
   *  processes hold a page — absent evidence, never an accusation. */
  pagelessCount: number;
};

export type ProcessMetricRow = {
  pid: number;
  type: string;
  label: string;
  cpuPercent: number;
  memoryKb: number;
  /** Electron's name for a utility child — "Network Service", "Audio Service". */
  name?: string;
  serviceName?: string;
  /** Present only for renderers, and only when the shell could tell. */
  hostsPage?: boolean;
};

export type ProcessMetricsSummary = {
  /** When the sample was taken, ms since epoch on the shell's clock. */
  readAt: number;
  /** How long the CPU figures average over. ZERO MEANS NO RATE YET — one
   *  sample cannot be a rate, and 0% would read as an idle app. */
  windowMs: number;
  totals: { cpuPercent: number; memoryKb: number; processes: number };
  types: ProcessTypeTotal[];
  /** The busiest individual processes, busiest first. */
  busiest: ProcessMetricRow[];
};

/**
 * ONE RENDERER THE SHELL'S WATCHDOG IS WORRIED ABOUT — issue #787.
 *
 * Not a second reading of anything. This is `service-worker-watchdog.js`'s own
 * per-poll decision, pushed out of the main process: a renderer at or above the
 * kill threshold, hosting no page, for two consecutive polls.
 */
export type RunawayRenderer = {
  pid: number;
  /** Percent of ONE core, over the watchdog's own ~30 s window. */
  percent: number;
  /** How many consecutive polls it has been hot for. */
  polls: number;
  /** Whether the shell killed it on this poll. `false` is the case #787 names
   *  as the worst: sustained, page-less, and deliberately NOT killed because no
   *  service worker is running without a tab to name it as — so it persists. */
  killed: boolean;
  /** The origins that could have been it. Candidates, never an identification —
   *  Electron gives a service-worker renderer no origin. Empty when none. */
  origins: string[];
};

export type RunawayNotice = {
  /** The shell's clock when the poll was taken. `0` means the shell has not
   *  polled yet, which is not the same as "nothing is hot". */
  at: number;
  renderers: RunawayRenderer[];
};

type MetricsBridge = {
  read: () => Promise<ProcessMetricsSummary>;
  /** Absent on a shell too old to push. See `useRunawayNotice`. */
  runaway?: () => Promise<RunawayNotice>;
  onRunaway?: (listener: (notice: RunawayNotice) => void) => () => void;
};

export function desktopMetrics(): MetricsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { metrics?: MetricsBridge } }).telarDesktop?.metrics;
}

/** The load at which the shell's own watchdog calls a page-less renderer a
 *  runaway and kills it (`apps/desktop/service-worker-watchdog.js`). The number
 *  is repeated rather than imported because the cockpit cannot import from the
 *  shell — if it moves there, it moves here, and the test says so. */
export const RUNAWAY_CPU_PERCENT = 80;

/** Read once, from whichever door this build has. */
export async function readProcessMetrics(): Promise<ProcessMetricsSummary> {
  const bridge = desktopMetrics();
  if (bridge) return bridge.read();
  const response = await fetch("/api/desktop/metrics", { cache: "no-store" });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : "The Telar desktop shell did not answer.";
    throw new Error(message);
  }
  return payload as ProcessMetricsSummary;
}

/** Percent of one core, for a reader. A busy app reports hundreds; a figure
 *  under 1% is shown as such rather than rounded away to a flat zero, because
 *  "0%" and "almost nothing" are answers to different questions. */
export function formatCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

export function formatMemory(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return "—";
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The window the CPU figures were averaged over, said plainly. */
export function formatWindow(windowMs: number): string {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return "no reading yet";
  const seconds = windowMs / 1000;
  return seconds < 1 ? "averaged over under a second" : `averaged over ${Math.round(seconds)}s`;
}

/** What a process is, for the busiest list: a utility's own name where Electron
 *  gave one, the type otherwise. */
export function describeProcess(row: ProcessMetricRow): string {
  return row.name || row.serviceName || row.label;
}

/**
 * THE PROCESSES WORTH SAYING SOMETHING ABOUT, hottest first.
 *
 * `runaway` is the case the incident was: a renderer at or above the watchdog's
 * threshold that is hosting no page at all. The shell will kill that one within
 * two polls; naming it is how somebody watching learns the fans are not their
 * build. A process over the threshold WITH a page is `hot` — a real reading,
 * and not something anybody should kill, because it is a page doing work.
 *
 * NOTHING IS FLAGGED WITHOUT A WINDOW. Before the second sample every rate is
 * zero, and a section that announced "nothing is busy" a beat before showing a
 * core pinned would be worse than one that said nothing.
 */
export function concerning(summary: ProcessMetricsSummary | undefined, threshold = RUNAWAY_CPU_PERCENT): { row: ProcessMetricRow; kind: "runaway" | "hot" }[] {
  if (!summary || summary.windowMs <= 0) return [];
  return summary.busiest
    .filter((row) => row.cpuPercent >= threshold)
    .map((row) => ({ row, kind: row.hostsPage === false ? ("runaway" as const) : ("hot" as const) }));
}

type MetricsState = {
  summary: ProcessMetricsSummary | undefined;
  error: string | undefined;
  /** Whether this build can report at all. `undefined` until the first answer:
   *  a section that appeared and vanished would be worse than one that arrives. */
  supported: boolean | undefined;
  refresh: () => void;
};

/**
 * POLL WHILE SOMEBODY IS LOOKING, and not otherwise.
 *
 * A hidden tab is nobody watching, and a background poll every two seconds for
 * the rest of the day is the kind of thing this page exists to find. The
 * listener is on `visibilitychange` rather than a mount check because the tab
 * this cockpit lives in is routinely left open behind other windows.
 *
 * A FAILED FIRST READ WITH NO BRIDGE IS SILENCE, deliberately — it cannot tell
 * "no desktop shell" from "the shell is wedged", and telling somebody browsing
 * the cockpit from a phone that their Mac is broken on the strength of a 503 is
 * the worse of those two guesses. Inside the shell the bridge is proof the
 * surface applies, so there an error is shown.
 */
export function useProcessMetrics(intervalMs = 2_000): MetricsState {
  const [summary, setSummary] = useState<ProcessMetricsSummary>();
  const [error, setError] = useState<string>();
  const [supported, setSupported] = useState<boolean | undefined>(() => (desktopMetrics() ? true : undefined));
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Never stack requests: a shell too busy to answer in two seconds is
    // exactly the condition this page is open to look at.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await readProcessMetrics();
      setSummary(next);
      setSupported(true);
      setError(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The Telar desktop shell did not answer.";
      if (desktopMetrics()) {
        setSupported(true);
        setError(message);
      } else {
        setSupported(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
    };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      // Back in front of somebody: answer now rather than up to one interval
      // later, so the first thing they read is not a stale sample.
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, intervalMs]);

  return { summary, error, supported, refresh: () => void refresh() };
}

/**
 * THE AMBIENT HALF — issue #787.
 *
 * `useProcessMetrics` above polls every two seconds and ONLY while its page is
 * visible, which is right for a page of live figures and is exactly why #488 did
 * not close #787: it draws nothing anywhere else, so the runaway is legible only
 * to somebody already looking at it.
 *
 * SO THIS ONE NEVER POLLS. The shell's watchdog is already deciding "hot, with
 * no page, for two consecutive polls" every thirty seconds in order to kill; the
 * decision is pushed here. No timer, no interval, no `visibilitychange` — and
 * crucially no second caller of `app.getAppMetrics()`, which is a CORRECTNESS
 * constraint rather than a cost (`apps/desktop/process-metrics.js`: the API's
 * baseline is per-API, so a second caller silently retunes the watchdog's
 * thirty-second average).
 *
 * THE SEED IS WHY A MOUNT IS NOT BLIND. A renderer that arrived between polls
 * asks for the last thing the shell said rather than waiting up to thirty
 * seconds for the next one.
 *
 * `undefined` MEANS NOTHING HAS BEEN SAID — an older shell with no bridge, a
 * browser tab, or a shell that has not completed its first poll. It is NOT the
 * same as an empty `renderers`, which is a poll that ran and found nothing, and
 * the two must not draw the same thing for the reason the whole issue exists:
 * a surface that cannot tell "quiet" from "not listening" is one people learn
 * to ignore.
 */
export function useRunawayNotice(): RunawayNotice | undefined {
  const [notice, setNotice] = useState<RunawayNotice>();

  useEffect(() => {
    const bridge = desktopMetrics();
    if (!bridge?.onRunaway) return;
    let live = true;
    // Seed first, then subscribe. The other order can drop a poll that lands
    // between the two calls; this one can only ever replace it with a newer
    // reading, because the push always carries the shell's latest.
    void bridge.runaway?.().then((seed) => {
      // A push that already landed is newer than the seed the shell answered
      // with, so it is never overwritten by it.
      if (live) setNotice((held) => (held === undefined ? seed : held));
    }).catch(() => {
      /* a shell that cannot answer says nothing, which is what `undefined` is */
    });
    const stop = bridge.onRunaway((next) => {
      if (live) setNotice(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  return notice;
}
