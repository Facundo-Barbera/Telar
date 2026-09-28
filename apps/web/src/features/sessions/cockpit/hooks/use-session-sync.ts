"use client";

import { type SetStateAction, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { EngineEvent, Session, SessionSnapshot } from "@telar/engine-client";
import { asEngineError, createEngineApi, INITIAL_TURNS, loadOlderTurns, projectJournal, sessionConnection, tailIntervalMs, type EngineApiError } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";
import { usePoll } from "@/ui/hooks/use-poll";
import { saveSnapshot, snapshotKey, snapshotStore } from "../../snapshot-cache";
import { recallTranscript, rememberTranscript, transcriptKey } from "../transcript-cache";
import { decideStale } from "../stale-state";
import { emptySessionData, sessionDataReducer } from "../session-data";

type Snapshot = SessionSnapshot & { events?: EngineEvent[] };
const PHOTOGRAPHED = ["session", "turns", "items", "tasks", "requests", "events"] as const;
type Photo = { id: string } & Pick<Snapshot, (typeof PHOTOGRAPHED)[number]>;

/** Records identities, not contents, so a tail that changed nothing is not written again. */
function record(photographed: { current: Photo | undefined }, host: string, id: string, snapshot: Snapshot) {
  rememberTranscript(transcriptKey(host, id), { ...snapshot, events: snapshot.events ?? [], cursor: snapshot.cursor ?? 0 });
  const store = snapshotStore();
  if (!store) return;
  const held = photographed.current;
  if (held && held.id === id && PHOTOGRAPHED.every((field) => held[field] === snapshot[field])) return;
  photographed.current = { id, ...Object.fromEntries(PHOTOGRAPHED.map((field) => [field, snapshot[field]])) } as Photo;
  const foldedItems = snapshot.events ? projectJournal(snapshot.turns, snapshot.items, snapshot.events, snapshot.tasks)
    .flatMap((turn) => [...turn.items, ...turn.tasks.flatMap((task) => task.items)])
    .map((item) => ({ ...item, streamed: item.streamedText, streamedThrough: snapshot.cursor ?? item.streamedThrough })) : snapshot.items;
  void saveSnapshot(store, host, id, {
    session: snapshot.session,
    turns: snapshot.turns,
    items: foldedItems,
    tasks: snapshot.tasks,
    requests: snapshot.requests,
    ...(snapshot.page ? { page: snapshot.page } : {}),
  }).catch(() => undefined);
}

export function useSessionSync({ hostId, sessionId, initiallyLoading }: { hostId: string; sessionId: string | undefined; initiallyLoading: boolean }) {
  const [data, dispatch] = useReducer(sessionDataReducer, emptySessionData);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<EngineApiError>();
  const [stale, setStale] = useState<number>();
  const staleAt = useRef<number | undefined>(undefined);
  const lastLiveAt = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(initiallyLoading);
  const photographed = useRef<Photo>(undefined);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const syncKey = JSON.stringify([hostId, sessionId]);
  const syncSession = useRef(syncKey);
  const syncGeneration = useRef(0);
  const tailInFlight = useRef(false);
  const transcriptLanded = !sessionId || data.readKey === syncKey;

  const [transcriptSubject, setTranscriptSubject] = useState(syncKey);
  if (transcriptSubject !== syncKey) {
    setTranscriptSubject(syncKey);
    const recalled = sessionId ? recallTranscript(transcriptKey(hostId, sessionId)) : undefined;
    if (recalled) dispatch({ type: "replace", data: recalled, readKey: syncKey });
  }

  useEffect(() => {
    if (syncSession.current === syncKey) return;
    syncSession.current = syncKey;
    syncGeneration.current += 1;
    syncQueue.current = Promise.resolve();
    tailInFlight.current = false;
  }, [syncKey]);

  const enqueueSync = useCallback((operation: () => Promise<void>) => {
    const next = syncQueue.current.then(operation, operation);
    syncQueue.current = next.catch(() => undefined);
    return next;
  }, []);
  /** Any answer, even an empty tail, proves the engine is reachable and clears the banner. */
  const remember = useCallback((id: string, snapshot: Snapshot) => {
    lastLiveAt.current = Date.now();
    if (staleAt.current !== undefined) {
      staleAt.current = undefined;
      setStale(undefined);
    }
    record(photographed, hostId, id, snapshot);
  }, [hostId]);
  const fail = useCallback((cause: unknown, fallback: string) => {
    const failure = asEngineError(cause, fallback);
    const [cachedAt, liveAt] = [staleAt.current, lastLiveAt.current];
    const at = decideStale({
      code: failure.code,
      hasContent: cachedAt !== undefined || liveAt !== undefined,
      ...(cachedAt === undefined ? {} : { cachedAt }),
      ...(liveAt === undefined ? {} : { lastLiveAt: liveAt }),
    });
    if (at === undefined) {
      setError(failure);
      return;
    }
    setError(undefined);
    staleAt.current = at;
    setStale(at);
  }, []);
  const read = useCallback(
    (id: string) => sessionConnection(hostId, createEngineApi(hostFetcher(hostId)), id, { turns: INITIAL_TURNS }).read(),
    [hostId],
  );
  const pull = useCallback(
    (type: "replace" | "tail") =>
      enqueueSync(async () => {
        if (!sessionId) return;
        const generation = syncGeneration.current;
        const snapshot = await read(sessionId);
        if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
        dispatch(type === "replace" ? { type, data: snapshot, readKey: syncKey } : { type, data: snapshot });
        remember(sessionId, snapshot);
      }),
    [enqueueSync, sessionId, remember, read, syncKey],
  );
  const hydrate = useCallback(() => pull("replace"), [pull]);
  const page = data.page;
  const loadOlder = useCallback(() => {
    const before = page?.before;
    if (!sessionId || !before || loadingOlder) return;
    setLoadingOlder(true);
    void enqueueSync(async () => {
      const generation = syncGeneration.current;
      const older = await loadOlderTurns(createEngineApi(hostFetcher(hostId)), sessionId, before);
      if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
      dispatch({ type: "older", data: older });
    })
      .catch((cause) => setError(asEngineError(cause, "Could not load earlier turns.")))
      .finally(() => setLoadingOlder(false));
  }, [enqueueSync, sessionId, page, loadingOlder, syncKey, hostId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    lastLiveAt.current = undefined;
    staleAt.current = undefined;
    void snapshotStore()
      ?.read(snapshotKey(hostId, sessionId))
      .then((cached) => {
        if (!cached || cancelled || lastLiveAt.current !== undefined) return;
        if (recallTranscript(transcriptKey(hostId, sessionId))) return;
        dispatch({ type: "replace", data: { ...cached, events: [] } });
        staleAt.current = cached.savedAt;
        setStale(cached.savedAt);
        setLoading(false);
      }, () => undefined);
    void hydrate()
      .then(
        () => !cancelled && setError(undefined),
        (cause) => {
          if (cancelled) return;
          fail(cause, "Could not hydrate this session.");
          dispatch({ type: "landed", readKey: syncKey });
        },
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hydrate, sessionId, hostId, fail, syncKey]);

  usePoll((signal) => {
    if (tailInFlight.current) return;
    tailInFlight.current = true;
    const generation = syncGeneration.current;
    return pull("tail")
      .catch((cause) => !signal.aborted && fail(cause, "Could not tail the session journal."))
      .finally(() => {
        if (generation === syncGeneration.current) tailInFlight.current = false;
      });
  }, sessionId ? tailIntervalMs(data.turns) : null, { immediate: false, key: syncKey });

  const setSession = useCallback((next: SetStateAction<Session | undefined>) => dispatch({ type: "session", next }), []);
  const clearTranscript = useCallback(() => dispatch({ type: "clear" }), []);
  const session = sessionId ? data.session : undefined;
  return { ...data, session, setSession, clearTranscript, loadOlder, loadingOlder, error, setError, stale, loading, syncKey, transcriptLanded, hydrate };
}
