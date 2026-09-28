"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hostVisible, subscribeHostVisibility } from "@/platform/desktop/host-visibility";

type ProcessTypeTotal = {
  type: string;
  label: string;
  count: number;
  cpuPercent: number;
  memoryKb: number;
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
  hostsPage?: boolean;
};

export type ProcessMetricsSummary = {
  readAt: number;
  windowMs: number;
  totals: { cpuPercent: number; memoryKb: number; processes: number };
  types: ProcessTypeTotal[];
  busiest: ProcessMetricRow[];
};

export type RunawayRenderer = {
  pid: number;
  percent: number;
  polls: number;
  killed: boolean;
  origins: string[];
};

export type RunawayNotice = {
  at: number;
  renderers: RunawayRenderer[];
};

type MetricsBridge = {
  read: () => Promise<ProcessMetricsSummary>;
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

export function formatCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

type MetricsState = {
  summary: ProcessMetricsSummary | undefined;
  error: string | undefined;
  supported: boolean | undefined;
  refresh: () => void;
};

export function useProcessMetrics(intervalMs = 2_000): MetricsState {
  const [summary, setSummary] = useState<ProcessMetricsSummary>();
  const [error, setError] = useState<string>();
  const [supported, setSupported] = useState<boolean | undefined>(() => (desktopMetrics() ? true : undefined));
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
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

export function useRunawayNotice(): RunawayNotice | undefined {
  const [notice, setNotice] = useState<RunawayNotice>();

  useEffect(() => {
    const bridge = desktopMetrics();
    if (!bridge?.onRunaway) return;
    let live = true;
    void bridge.runaway?.().then((seed) => {
      if (live) setNotice((held) => (held === undefined ? seed : held));
    }).catch(() => {
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
