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

type MetricsBridge = { read: () => Promise<ProcessMetricsSummary> };

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
