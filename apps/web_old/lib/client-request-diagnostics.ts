"use client";

import {
  getIdleRequestBudgetDiagnostics,
  type IdleRequestBudgetSnapshot,
} from "@/lib/client-request-budget";

type RequestEntry = {
  count: number;
  failures: number;
  inFlight: number;
  lastDurationMs: number | null;
  lastStartedAt: string | null;
};

type StreamEntry = {
  opened: number;
  reconnects: number;
  open: number;
};

export type ClientRequestDiagnostics = {
  requests: Record<string, RequestEntry>;
  streams: Record<string, StreamEntry>;
  idleBudget: IdleRequestBudgetSnapshot;
};

const requests = new Map<string, RequestEntry>();
const streams = new Map<string, StreamEntry>();

function enabled() {
  return process.env.NODE_ENV === "development" && typeof window !== "undefined";
}

function requestEntry(key: string) {
  const existing = requests.get(key);
  if (existing) return existing;
  const next: RequestEntry = {
    count: 0,
    failures: 0,
    inFlight: 0,
    lastDurationMs: null,
    lastStartedAt: null,
  };
  requests.set(key, next);
  return next;
}

function streamEntry(key: string) {
  const existing = streams.get(key);
  if (existing) return existing;
  const next: StreamEntry = { opened: 0, reconnects: 0, open: 0 };
  streams.set(key, next);
  return next;
}

export function getClientRequestDiagnostics(): ClientRequestDiagnostics {
  return {
    requests: Object.fromEntries(requests),
    streams: Object.fromEntries(streams),
    idleBudget: getIdleRequestBudgetDiagnostics(),
  };
}

export async function diagnosticFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  reason: string,
) {
  if (!enabled()) return fetch(input, init);
  const method = init?.method ?? "GET";
  const key = `${method} ${String(input)} · ${reason}`;
  const entry = requestEntry(key);
  const startedAt = performance.now();
  entry.count += 1;
  entry.inFlight += 1;
  entry.lastStartedAt = new Date().toISOString();
  try {
    const response = await fetch(input, init);
    if (!response.ok) entry.failures += 1;
    return response;
  } catch (error) {
    entry.failures += 1;
    throw error;
  } finally {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastDurationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  }
}

export function diagnosticEventSource(url: string, reason: string) {
  const source = new EventSource(url);
  if (!enabled()) return { source, close: () => source.close() };

  const key = `${url} · ${reason}`;
  const entry = streamEntry(key);
  let opened = false;
  let closed = false;
  entry.opened += 1;
  entry.open += 1;
  source.addEventListener("open", () => {
    if (opened) entry.reconnects += 1;
    opened = true;
  });
  return {
    source,
    close: () => {
      if (!closed) {
        closed = true;
        entry.open = Math.max(0, entry.open - 1);
      }
      source.close();
    },
  };
}

if (enabled()) {
  window.__telarRequestDiagnostics = getClientRequestDiagnostics;
}
