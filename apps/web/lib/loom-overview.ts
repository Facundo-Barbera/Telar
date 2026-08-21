"use client";

/**
 * THE DECK'S ONE READ, AND THE RUN REGISTRY'S.
 *
 * `GET /api/looms` returns the WHOLE deck in one call — projects, looms,
 * triage, in-flight runs, unreadable files. Not five endpoints on five
 * cadences: two surfaces fetched separately disagree, and nothing in either
 * payload says which half is stale. The spool learned that expensively and the
 * rule is written into its store; this hook is that rule on the client.
 *
 * ── TWO CADENCES ─────────────────────────────────────────────────────────────
 * Fast while anything is being advanced — a loom in flight, a tick running, a
 * watch armed — and slow otherwise. A cockpit with nothing happening is a
 * static page, and tailing it at a second a beat would be a request storm for a
 * screen nobody is watching change. The idle beat is not zero, because the
 * supervisor can start work with nobody in the browser at all: a night that
 * began while you were asleep has to appear without a click.
 *
 * THE ACTIVE FLAG IS A REF, NOT STATE. It decides only whether the next tick
 * fires; putting it in state would re-render every consumer to change a boolean
 * nothing draws. `began()` sets it without a render for the same reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerEntry, LoomOverview, LoomRun } from "@telar/engine-client";
import { overviewActive } from "./loom-deck";

/** Fast enough that a step line reads as live. The spool's work tail uses 900. */
const TICK_MS = 1200;
/** The idle beat: slow enough to be free against a loopback daemon. */
const IDLE_TICK_MS = 5000;

export const EMPTY_OVERVIEW: LoomOverview = {
  projects: [],
  looms: [],
  triage: [],
  runs: [],
  unreadable: [],
};

export type LoomOverviewView = {
  overview: LoomOverview;
  /**
   * WHEN THIS SNAPSHOT ARRIVED — the surface's one clock.
   *
   * Every "3m ago" on the deck is measured against this, not against a fresh
   * `Date.now()` read during render. Two reasons, and both have bitten this app
   * before: the server and the first client render must agree or React
   * regenerates the tree, and a clock that ticks independently of the data
   * would age rows that have not been re-read. 0 until the first read lands, so
   * a surface with no clock yet can say nothing rather than "56y ago".
   */
  receivedAt: number;
  /** True until the first read lands, so an empty deck and a cold one differ. */
  loading: boolean;
  /** The last read failed, in the engine's own words. The stale snapshot stays up. */
  error?: string;
  refresh: () => void;
  /** Tell the hook something was just started, so it drops to the fast beat now. */
  began: () => void;
};

export function useLoomOverview(): LoomOverviewView {
  const [overview, setOverview] = useState<LoomOverview>(EMPTY_OVERVIEW);
  const [receivedAt, setReceivedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const active = useRef(false);
  const [awake, setAwake] = useState(0);

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/looms");
      if (!res.ok) {
        setError(`The engine answered ${res.status} for the deck.`);
        setLoading(false);
        return;
      }
      const snapshot = (await res.json()) as Partial<LoomOverview>;
      const next: LoomOverview = {
        projects: snapshot.projects ?? [],
        looms: snapshot.looms ?? [],
        triage: snapshot.triage ?? [],
        runs: snapshot.runs ?? [],
        unreadable: snapshot.unreadable ?? [],
      };
      active.current = overviewActive(next);
      setOverview(next);
      setReceivedAt(Date.now());
      setError(undefined);
      setLoading(false);
    } catch {
      // A dropped read leaves the last good deck up. It is pull-based, and a
      // failed request has not unmade anything that was on screen.
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred to a task rather than run in the effect body — a synchronous
    // fetch-and-setState on mount is a cascading render, and this app lints it.
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read, awake]);

  useEffect(() => {
    const timer = window.setInterval(() => void read(), active.current ? TICK_MS : IDLE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [read, awake]);

  return useMemo(
    () => ({
      overview,
      receivedAt,
      loading,
      ...(error ? { error } : {}),
      refresh: () => setAwake((n) => n + 1),
      began: () => {
        active.current = true;
        setAwake((n) => n + 1);
      },
    }),
    [overview, receivedAt, loading, error],
  );
}

export type LoomWorkView = {
  runs: LoomRun[];
  /** The newest run of a kind for one project — what the dry-run report reads. */
  latest: (projectId: string, kind: LoomRun["kind"]) => LoomRun | undefined;
  running: (projectId: string) => LoomRun | undefined;
  refresh: () => void;
  began: () => void;
};

/**
 * IN-FLIGHT TICKS, WHICH ARE NOT DURABLE DATA.
 *
 * The engine holds these in memory, so this route is as expensive as reading a
 * Map. It is a SEPARATE hook from the overview on purpose and without breaking
 * the one-call rule: a run and a loom are disjoint facts, so the two reads
 * cannot disagree about the same thing the way two halves of one deck can.
 * Modelled on `lib/spool-work.ts`, down to the ref.
 */
export function useLoomWork(): LoomWorkView {
  const [runs, setRuns] = useState<LoomRun[]>([]);
  const active = useRef(false);
  const [awake, setAwake] = useState(0);

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/looms/work");
      const data = res.ok ? await res.json() : { runs: [] };
      const next: LoomRun[] = data.runs ?? [];
      active.current = next.some((run) => run.state === "running");
      setRuns(next);
    } catch {
      // A dropped poll is not worth a banner: the next tick retries and the
      // last good record stays on screen. A run that is still running has not
      // stopped because one request did.
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read, awake]);

  useEffect(() => {
    const timer = window.setInterval(() => void read(), active.current ? TICK_MS : IDLE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [read, awake]);

  return useMemo(
    () => ({
      runs,
      // LAST WINS: the registry is insertion-ordered, so the newest matching
      // run is the last one in the list.
      latest: (projectId, kind) => runs.filter((run) => run.projectId === projectId && run.kind === kind).at(-1),
      running: (projectId) => runs.find((run) => run.projectId === projectId && run.state === "running"),
      refresh: () => setAwake((n) => n + 1),
      began: () => {
        active.current = true;
        setAwake((n) => n + 1);
      },
    }),
    [runs],
  );
}

/**
 * THE LEDGER — what an agent that deliberately does not remember left behind.
 *
 * A TICK HAS NO TRANSCRIPT. It is a fresh instance every time, it accumulates
 * nothing, and that is the entire reason cost does not ramp with uptime. So
 * there is no conversation to open for the thing that ran at 3am, and offering
 * one would be an affordance with nothing behind it. This append-only journal
 * and the run record are the whole record, which is why the UI surfaces them
 * where a chat would otherwise have gone.
 *
 * Polled only while its surface is open, at the idle beat: a ledger only grows
 * when a tick runs, and a tick is minutes apart at best.
 */
export function useLoomLedger(
  projectId: string | undefined,
  enabled: boolean,
  limit = 60,
): { entries: LedgerEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const read = useCallback(async () => {
    if (!projectId || !enabled) return;
    try {
      const res = await fetch(
        `/api/looms/ledger?project=${encodeURIComponent(projectId)}&limit=${encodeURIComponent(String(limit))}`,
      );
      const data = res.ok ? await res.json() : { entries: [] };
      setEntries(data.entries ?? []);
    } catch {
      // The last good journal stays on screen; nothing was unwritten by a
      // dropped request.
    } finally {
      setLoading(false);
    }
  }, [projectId, enabled, limit]);

  useEffect(() => {
    // Deferred to a task — a synchronous fetch-and-setState on mount is a
    // cascading render, and this app lints it.
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void read(), IDLE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [read, enabled]);

  return { entries, loading };
}
