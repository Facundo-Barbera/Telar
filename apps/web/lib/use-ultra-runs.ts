"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// `import type` IS ERASED AT BUILD TIME, so pulling these shapes from the
// server-only `@telar/core` package here carries no runtime code — the same
// erasure `use-accounts.ts` and `use-ultra-wake.ts` both rely on, and the one
// INV-4 checks by walking VALUE edges out of every "use client" file.
import type { UltraEvent, UltraManifest } from "@telar/core";
import { refreshIncludes } from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
import {
  type AgentIndexRow,
  type RunSnapshot,
  reconcileStreams,
  runSnapshot,
  unwrapManifest,
  unwrapManifests,
  wantedStreams,
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
//   ONE `EventSource` PER RUN WHOSE JOURNAL THIS PAGE STILL NEEDS answers "what
//   did this run do", against `/api/ultra/[id]/events` — the channel
//   `ui-contract.md` names and story 4.1's D9 explicitly reserved for this
//   story.
//
// REVIEW ROUND 1 / B1 — A TERMINAL RUN GETS ITS JOURNAL READ TOO, EXACTLY ONCE.
// This file used to say "NO STREAM IS OPENED FOR A TERMINAL RUN; it reconciles
// from the list", and that sentence was the defect: the LIST is a list of
// MANIFESTS, and a manifest carries no agent count, no phase history and no log
// lines. So a run that settled before the page mounted rendered `0 done`, an
// empty rail card and a `0 of 2` sliver — three figures stated as fact by a
// reader that had never opened the only channel that knows them. The route
// replays every event from line 0 and then sends `end` for a terminal run, so
// one open IS a one-shot read; `hydrated` below is what keeps it to one.
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
// event, and on an interval WHILE SOMETHING RUNS. Still self-limiting, and the
// cost of the B1 fix is stated rather than hidden: a session whose runs are all
// terminal polls the list once, opens ONE stream and ONE `agents/` request PER
// RUN — bounded by that session's own run count, once per page — and then does
// nothing at all until a run starts.
const POLL_MS = 4000;

type RunRow = UltraManifest & { name?: string };
type Stream = {
  manifest: UltraManifest | null;
  events: UltraEvent[];
  /** the route sent `end`, so `events` is this run's WHOLE journal */
  drained: boolean;
};

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
  // Runs whose journal has been drained to `end` at least once. A ref for the
  // same reason: it gates a side effect and must not itself schedule a render.
  const hydrated = useRef<Set<string>>(new Set());
  // Runs whose agent index has been pulled at least once, so a terminal run
  // costs one request rather than one per list change.
  const indexed = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!sessionId) {
      setRows([]);
      return;
    }
    try {
      const data = await cachedJson<unknown>(
        `/api/ultra?sessionId=${encodeURIComponent(sessionId)}`,
        { force: true },
      );
      // ONE envelope adapter, used everywhere (§5.6-T16). Three shapes exist for
      // this one object and unwrapping inline is how you unwrap the wrong level
      // exactly once, in the case you tested least.
      setRows(unwrapManifests(data) as RunRow[]);
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
    const onRefresh = (event: Event) => {
      if (refreshIncludes(event, "ultra")) void reload();
    };
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

  // EVERY run this session has, live or not (B1). A sorted, joined string for
  // the same reason `liveIds` is one: it is an effect key, and a fresh array
  // every poll would re-run the effect on every tick of data it already has.
  const allIds = useMemo(
    () =>
      rows
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

  // ONE STREAM PER RUN THAT STILL NEEDS ONE, RECONCILED INCREMENTALLY. The
  // effect key is the sorted id list, so it re-runs when a run appears or goes
  // terminal and not on every tick of the data those streams deliver.
  //
  // THE CLEANUP DOES NOT CLOSE ANYTHING, AND THAT IS THE FIX (review SF-1).
  // React runs an effect's cleanup on EVERY dependency change, so a
  // close-everything cleanup meant a second run launching tore down the first
  // run's still-wanted stream — after which `wantedStreams`/`reconcileStreams`
  // found nothing open, re-opened it, and the route replayed the whole journal
  // into `streams` a second time. Unmount closes everything, in its own effect
  // below; every other transition is the reconciler's job.
  useEffect(() => {
    const open = sources.current;
    const wanted = wantedStreams(
      liveIds === "" ? [] : liveIds.split(","),
      allIds === "" ? [] : allIds.split(","),
      hydrated.current,
    );
    const step = reconcileStreams([...open.keys()], wanted);
    for (const runId of step.close) {
      open.get(runId)?.close();
      open.delete(runId);
    }
    for (const runId of step.open) {
      const es = new EventSource(`/api/ultra/${encodeURIComponent(runId)}/events`);
      open.set(runId, es);
      // OPENING UN-HYDRATES, and this line is not bookkeeping — without it a
      // RESUMED run loses its journal permanently. `hydrated` must mean "the
      // CURRENT connection drained to `end`", not "some past connection did".
      // The sequence: run A is terminal and hydrated; the user clicks Resume, so
      // A is live again and gets a fresh stream whose `open` handler resets
      // `events` to []; A settles, and if the 4 s list poll sees the terminal
      // manifest before the 400 ms SSE tail delivers `end`, A leaves the live
      // set while still hydrated — so the reconciler closes it, `end` never
      // arrives, `drained` stays false, and the projection reads `journal =
      // null` for that run for the life of the page. Deleting here keeps A
      // wanted (it is un-hydrated) until its own `end` says otherwise. It cannot
      // loop: the stream is in `open`, so `reconcileStreams` will not re-open it.
      hydrated.current.delete(runId);
      // THE ACCUMULATOR IS RESET ON EVERY CONNECTION, not just the first. The
      // route's `nextLine = 0` lives INSIDE `start(controller)`, i.e. per
      // connection, so every connect replays the journal from line 0 — and an
      // `EventSource` reconnects on its own after a transport error. Appending a
      // second replay onto the first is what made the narrator repeat itself;
      // `open` fires before any message on that connection, so this is the one
      // place the reset is exactly one replay wide.
      //
      // THE COST, STATED: on a RECONNECT this briefly under-reports — the
      // accumulator is empty for the tick between `open` and the replay landing,
      // so a live run's `agentsDone` can blink to 0 and back. That is the trade
      // taken deliberately: the alternative it replaces was a permanent
      // OVER-report (a narrator repeating its whole history, growing once per
      // reconnect), and a figure that is briefly low and self-corrects is a
      // smaller lie than one that is wrong forever and compounds.
      es.addEventListener("open", () => {
        setStreams((prev) => ({
          ...prev,
          [runId]: { manifest: prev[runId]?.manifest ?? null, events: [], drained: false },
        }));
      });
      es.addEventListener("run", (e) => {
        const manifest = unwrapManifest(safeParse((e as MessageEvent).data));
        if (!manifest) return;
        setStreams((prev) => ({
          ...prev,
          [runId]: {
            manifest,
            events: prev[runId]?.events ?? [],
            drained: prev[runId]?.drained ?? false,
          },
        }));
      });
      es.addEventListener("ev", (e) => {
        const ev = safeParse((e as MessageEvent).data) as UltraEvent | null;
        if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") return;
        setStreams((prev) => {
          const prior = prev[runId] ?? { manifest: null, events: [], drained: false };
          return { ...prev, [runId]: { ...prior, events: [...prior.events, ev] } };
        });
      });
      es.addEventListener("end", (e) => {
        const manifest = unwrapManifest(safeParse((e as MessageEvent).data));
        // `end` means the journal is COMPLETE, which is what licenses the
        // projection to state `agentsDone` and the sliver for this run at all.
        const wasLive = liveIds !== "" && liveIds.split(",").includes(runId);
        hydrated.current.add(runId);
        setStreams((prev) => {
          const prior = prev[runId] ?? { manifest: null, events: [], drained: false };
          return {
            ...prev,
            [runId]: { ...prior, ...(manifest ? { manifest } : {}), drained: true },
          };
        });
        // §5.6-T7 — WITHOUT THIS THE BROWSER RE-OPENS THE STREAM FOREVER.
        es.close();
        open.delete(runId);
        // A run that WENT terminal under this page's eyes has a final state the
        // list has not seen yet, and the list is what the rail and the dock
        // read. A run that was ALREADY terminal has nothing new to tell it, so
        // hydrating history costs no extra list polls.
        if (wasLive) void reload();
      });
      // A stream error is not a failure to report: the route can be silent for
      // an unbounded time on connect (the run dir may not exist yet) and there
      // is no heartbeat, so `onerror` here would fire on ordinary reconnects.
      // The list poll is the reconciler.
    }
  }, [liveIds, allIds, reload]);

  // THE ONLY PLACE EVERYTHING CLOSES: unmount. Kept apart from the reconciler
  // above so that closing a stream is never a side effect of the dependency
  // list moving (SF-1). A session change does not need it — `sessionId` moving
  // re-fetches the list, the id set changes with it, and the reconciler closes
  // what is no longer ours.
  useEffect(() => {
    const open = sources.current;
    return () => {
      for (const [, es] of open) es.close();
      open.clear();
    };
  }, []);

  // The agent index — the snippet's only source, and the only reader that can
  // see an ordinal the event stream has not mentioned yet. Polled beside the
  // list rather than streamed: it is a small per-run question, and adding a
  // second SSE channel per run would double the open connections for a figure
  // that changes on the same cadence the list does.
  // A TERMINAL RUN IS PULLED ONCE AND A LIVE RUN IS POLLED (B1). `agents/` is
  // the only reader that can see an ordinal at all for a run whose events this
  // page never streamed, and a finished run's index does not move — so history
  // costs one request per run per page, not one per cadence.
  useEffect(() => {
    if (!sessionId || allIds === "") return;
    let cancelled = false;
    const pull = async (ids: readonly string[]) => {
      for (const runId of ids) {
        try {
          const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/agents`);
          if (!r.ok || cancelled) continue;
          const d: unknown = await r.json();
          const agents = (d as { agents?: unknown }).agents;
          if (!Array.isArray(agents) || cancelled) continue;
          indexed.current.add(runId);
          setIndexes((prev) => ({ ...prev, [runId]: agents as AgentIndexRow[] }));
        } catch {
          // best-effort, same as the list poll
        }
      }
    };
    const live = liveIds === "" ? [] : liveIds.split(",");
    const first = allIds.split(",").filter((id) => live.includes(id) || !indexed.current.has(id));
    if (first.length > 0) void pull(first);
    if (live.length === 0) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(() => void pull(live), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, allIds, liveIds]);

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
      // `null`, NOT `[]`, until this run's journal has actually been read (B1).
      // A live run's stream is authoritative from the moment it connects — the
      // route replays from line 0 — so "connected" is enough for it; a terminal
      // run must have been DRAINED to `end`, because a half-arrived replay would
      // otherwise state a smaller `agentsDone` than the run really has.
      const journal =
        stream && (manifest.state === "running" || stream.drained) ? stream.events : null;
      const snap = runSnapshot(manifest, journal, indexes[row.runId] ?? [], row.runId);
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
