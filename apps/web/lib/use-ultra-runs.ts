"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// `import type` IS ERASED AT BUILD TIME, so pulling these shapes from the
// server-only `@telar/core` package here carries no runtime code — the same
// erasure `use-accounts.ts` and `use-ultra-wake.ts` both rely on, and the one
// INV-4 checks by walking VALUE edges out of every "use client" file.
import type { UltraEvent, UltraManifest } from "@telar/core";
import {
  type AgentIndexRow,
  type RunSnapshot,
  runSnapshot,
  unwrapManifest,
  unwrapManifests,
} from "@/lib/ultra-runs";

// Story 4.2 — Track D's client hook: this session's Ultra runs, live.
//
// TWO CHANNELS, ANSWERING TWO DIFFERENT QUESTIONS (§5.5-D4).
//
//   THE LIST POLL answers "which runs does this session have". One cheap
//   question on the house cadence, against `GET /api/ultra?sessionId=`, whose
//   rows already carry a server-rendered `name` (the client cannot call
//   `ultraRunLabel` — it is a core VALUE export and INV-4c fails on the edge by
//   name).
//
//   ONE `EventSource` PER LIVE RUN answers "what is happening right now" for a
//   run the user is looking at, against `/api/ultra/[id]/events` — the channel
//   `ui-contract.md` names and story 4.1's D9 explicitly reserved for this
//   story. NO STREAM IS OPENED FOR A TERMINAL RUN; it reconciles from the list.
//
// EVERY STREAM IS CLOSED ON ITS `end` FRAME (§5.6-T7), and that is not
// housekeeping. THE BROWSER RECONNECTS ON STREAM CLOSE BY DESIGN, so a missing
// `es.addEventListener("end", () => es.close())` re-opens the stream every few
// seconds, per anchor, per concurrent run, for the life of the page.
// `session-view.tsx` already does this correctly twice and is the template.
//
// THE NULL-`sessionId` WINDOW IS REAL AND IS HANDLED BY DOING NOTHING.
// `sessionId` is `string | null` in `session-view.tsx` and is null until the
// first turn's `session` event, so the very first turn of a brand-new session
// can launch a run before an id exists. The hook short-circuits to an empty map
// — it does not throw and it does not fetch — exactly as `use-ultra-wake.ts`'s
// reload does, and the anchor's PENDING form (`lib/ultra-runs.ts`'s
// `spliceRunAnchors` third argument) is what covers the gap until the first list
// poll answers.
//
// NO GLOBAL STORE, NO NEW CLIENT-STATE MECHANISM (NFR-X-15): `useState` /
// `useEffect` + `fetch`, refetch on mount, on the app-wide `telar:refresh`
// event, and on an interval WHILE SOMETHING RUNS. Self-limiting: a session whose
// runs are all terminal polls once and then stops.
const POLL_MS = 4000;

type RunRow = UltraManifest & { name?: string };
type Stream = { manifest: UltraManifest | null; events: UltraEvent[] };

export type UseUltraRuns = {
  /** Keyed by runId — the SAME object `spliceRunAnchors` takes, passed straight
   *  through with no re-keying and no `Record` in between. */
  runs: ReadonlyMap<string, RunSnapshot>;
  /** How many of this session's runs are still `running`. */
  live: number;
  reload: () => Promise<void>;
};

export function useUltraRuns(sessionId: string | null): UseUltraRuns {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [streams, setStreams] = useState<Record<string, Stream>>({});
  const [indexes, setIndexes] = useState<Record<string, AgentIndexRow[]>>({});
  // The open `EventSource`s, by runId. A ref and not state: opening a stream is
  // a side effect keyed on identity, and re-rendering because one opened would
  // re-run the effect that opened it.
  const sources = useRef<Map<string, EventSource>>(new Map());

  const reload = useCallback(async () => {
    if (!sessionId) {
      setRows([]);
      return;
    }
    try {
      const r = await fetch(`/api/ultra?sessionId=${encodeURIComponent(sessionId)}`);
      if (!r.ok) return;
      // ONE envelope adapter, used everywhere (§5.6-T16). Three shapes exist for
      // this one object and unwrapping inline is how you unwrap the wrong level
      // exactly once, in the case you tested least.
      setRows(unwrapManifests(await r.json()) as RunRow[]);
    } catch {
      // Best-effort. A failed poll means the list is one cadence stale; the
      // manifests on disk are the truth and the next poll re-answers.
    }
  }, [sessionId]);

  // THE ONE SUPPRESSION IN THIS FILE, and `use-ultra-wake.ts` carries the full
  // reasoning: `reload` is async and every setState in it sits behind an
  // `await fetch`, so nothing is set DURING the effect body. What the rule
  // actually keys on is that the effect body calls a function that transitively
  // calls setState at all — measured there rather than reasoned.
  //
  // THE DIRECTIVE MUST BE THE LINE IMMEDIATELY ABOVE THE CALL. Written with its
  // explanation trailing onto a second comment line, `eslint-disable-next-line`
  // applies to THAT COMMENT and the error still fires — which is how the first
  // version of this file shipped both an unused-directive warning AND the error
  // it was meant to suppress.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [reload]);

  const liveIds = useMemo(
    () =>
      rows
        .filter((r) => r.state === "running")
        .map((r) => r.runId)
        .sort()
        .join(","),
    [rows],
  );

  // The list poll, gated on something actually running.
  useEffect(() => {
    if (!sessionId || liveIds === "") return;
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [sessionId, liveIds, reload]);

  // ONE STREAM PER LIVE RUN. The effect key is the sorted id list, so it re-runs
  // when a run starts or goes terminal and not on every tick of the data those
  // streams deliver.
  useEffect(() => {
    const wanted = new Set(liveIds === "" ? [] : liveIds.split(","));
    const open = sources.current;
    // Close streams for runs that are no longer live (or no longer ours).
    for (const [runId, es] of open) {
      if (!wanted.has(runId)) {
        es.close();
        open.delete(runId);
      }
    }
    for (const runId of wanted) {
      if (open.has(runId)) continue;
      const es = new EventSource(`/api/ultra/${encodeURIComponent(runId)}/events`);
      open.set(runId, es);
      es.addEventListener("run", (e) => {
        const manifest = unwrapManifest(safeParse((e as MessageEvent).data));
        if (!manifest) return;
        setStreams((prev) => ({
          ...prev,
          [runId]: { manifest, events: prev[runId]?.events ?? [] },
        }));
      });
      es.addEventListener("ev", (e) => {
        const ev = safeParse((e as MessageEvent).data) as UltraEvent | null;
        if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") return;
        setStreams((prev) => {
          const prior = prev[runId] ?? { manifest: null, events: [] };
          return { ...prev, [runId]: { ...prior, events: [...prior.events, ev] } };
        });
      });
      es.addEventListener("end", (e) => {
        const manifest = unwrapManifest(safeParse((e as MessageEvent).data));
        if (manifest) {
          setStreams((prev) => ({
            ...prev,
            [runId]: { manifest, events: prev[runId]?.events ?? [] },
          }));
        }
        // §5.6-T7 — WITHOUT THIS THE BROWSER RE-OPENS THE STREAM FOREVER.
        es.close();
        open.delete(runId);
        // A terminal run's own final state also belongs on the list, and the
        // list is what the rail and the dock read.
        void reload();
      });
      // A stream error is not a failure to report: the route can be silent for
      // an unbounded time on connect (the run dir may not exist yet) and there
      // is no heartbeat, so `onerror` here would fire on ordinary reconnects.
      // The list poll is the reconciler.
    }
    return () => {
      // The page is going away (or the session changed): close everything. This
      // deliberately does NOT run on every list change — the effect key is the
      // live-id set, so a stream survives ticks of its own data.
      for (const [, es] of open) es.close();
      open.clear();
    };
  }, [liveIds, reload]);

  // The agent index — the snippet's only source, and the only reader that can
  // see an ordinal the event stream has not mentioned yet. Polled beside the
  // list rather than streamed: it is a small per-run question, and adding a
  // second SSE channel per run would double the open connections for a figure
  // that changes on the same cadence the list does.
  useEffect(() => {
    if (!sessionId || liveIds === "") return;
    let cancelled = false;
    const pull = async () => {
      for (const runId of liveIds.split(",")) {
        try {
          const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/agents`);
          if (!r.ok || cancelled) continue;
          const d: unknown = await r.json();
          const agents = (d as { agents?: unknown }).agents;
          if (!Array.isArray(agents) || cancelled) continue;
          setIndexes((prev) => ({ ...prev, [runId]: agents as AgentIndexRow[] }));
        } catch {
          // best-effort, same as the list poll
        }
      }
    };
    void pull();
    const id = setInterval(() => void pull(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, liveIds]);

  // THE PROJECTION. Every decision here lives in `lib/ultra-runs.ts` and is
  // tested there; this is assembly.
  const runs = useMemo(() => {
    const out = new Map<string, RunSnapshot>();
    for (const row of rows) {
      const stream = streams[row.runId];
      // The list row is the reconciler and the stream is the per-tick detail, so
      // the FRESHER manifest wins: a stream that has seen a newer `run` frame
      // than the last poll should not be dragged backwards by it, and a
      // terminal run whose stream closed should not be dragged back to
      // `running`.
      const manifest =
        stream?.manifest && stream.manifest.updatedAt >= row.updatedAt ? stream.manifest : row;
      const snap = runSnapshot(manifest, stream?.events ?? [], indexes[row.runId] ?? [], row.runId);
      // The list route rendered `name` server-side; prefer it over the
      // client-side copy of the label rule, which exists only for the
      // stream-only window (§5.5-D5a).
      out.set(row.runId, row.name ? { ...snap, name: row.name } : snap);
    }
    // A run known only to its stream — a launch whose list poll has not answered
    // yet — is still a run, and dropping it would make the anchor blink.
    for (const [runId, stream] of Object.entries(streams)) {
      if (out.has(runId)) continue;
      out.set(runId, runSnapshot(stream.manifest, stream.events, indexes[runId] ?? [], runId));
    }
    return out;
  }, [rows, streams, indexes]);

  const live = useMemo(() => [...runs.values()].filter((r) => r.state === "running").length, [runs]);

  return { runs, live, reload };
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
