"use client";

/**
 * The desktop shell's process metrics. Inside the shell this reads over the preload bridge;
 * elsewhere `/api/desktop/metrics` proxies to the shell's loopback control server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hostVisible, subscribeHostVisibility } from "@/lib/host-visibility";

type ProcessTypeTotal = {
  /** Electron's own `ProcessMetric.type`. */
  type: string;
  label: string;
  count: number;
  /** Percent of one core, so a machine with eight can report 800. */
  cpuPercent: number;
  memoryKb: number;
  /** Renderers hosting no visible page. Zero for other types and when the shell
   *  could not tell which processes hold a page. */
  pagelessCount: number;
};

type ProcessMetricRow = {
  pid: number;
  type: string;
  label: string;
  cpuPercent: number;
  memoryKb: number;
  name?: string;
  serviceName?: string;
  /** Present only for renderers, and only when the shell could tell. */
  hostsPage?: boolean;
};

export type ProcessMetricsSummary = {
  /** When the sample was taken, ms since epoch on the shell's clock. */
  readAt: number;
  /** Averaging window of the CPU figures. Zero means no rate yet, not an idle app. */
  windowMs: number;
  totals: { cpuPercent: number; memoryKb: number; processes: number };
  types: ProcessTypeTotal[];
  /** The busiest individual processes, busiest first. */
  busiest: ProcessMetricRow[];
};

/** A renderer the shell's watchdog flagged: over the kill threshold, hosting no page, for two consecutive polls. */
export type RunawayRenderer = {
  pid: number;
  /** Percent of one core, over the watchdog's own ~30 s window. */
  percent: number;
  /** How many consecutive polls it has been hot for. */
  polls: number;
  /** Whether the shell killed it on this poll; it is not killed when no service
   *  worker is running without a tab to name it as. */
  killed: boolean;
  /** Candidate origins, never an identification: Electron gives a service-worker renderer no origin. */
  origins: string[];
};

export type RunawayNotice = {
  /** `0` means the shell has not polled yet, which is not the same as "nothing is hot". */
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

/** Percent of one core; under 1% shows as "<1%" rather than rounding to zero. */
export function formatCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

type MetricsState = {
  summary: ProcessMetricsSummary | undefined;
  error: string | undefined;
  /** `undefined` until the first answer, so the section does not appear and vanish. */
  supported: boolean | undefined;
  refresh: () => void;
};

/**
 * Polls only while the host is visible (`hostVisible()`, since the desktop shell pins
 * `document.visibilityState` to "visible"). Without a bridge a failed read is silent, as it
 * cannot tell "no shell" from "shell wedged".
 */
export function useProcessMetrics(intervalMs = 2_000): MetricsState {
  const [summary, setSummary] = useState<ProcessMetricsSummary>();
  const [error, setError] = useState<string>();
  const [supported, setSupported] = useState<boolean | undefined>(() => (desktopMetrics() ? true : undefined));
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Never stack requests: a shell too busy to answer is what this page exists to show.
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
      if (hostVisible()) void refresh();
    };
    const unsubscribe = subscribeHostVisibility(tick);
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [refresh, intervalMs]);

  return { summary, error, supported, refresh: () => void refresh() };
}

/**
 * The watchdog's runaway notice, pushed from the shell; never polls, because a second caller
 * of `app.getAppMetrics()` retunes the watchdog's average. `undefined` means nothing has been
 * said yet, which is distinct from an empty `renderers`.
 */
export function useRunawayNotice(): RunawayNotice | undefined {
  const [notice, setNotice] = useState<RunawayNotice>();

  useEffect(() => {
    const bridge = desktopMetrics();
    if (!bridge?.onRunaway) return;
    let live = true;
    // Seed first, then subscribe: the other order can drop a poll that lands between the calls.
    void bridge.runaway?.().then((seed) => {
      // A push that already landed is newer than the seed.
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
