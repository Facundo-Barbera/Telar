"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffBaseOption, SessionDiff, TurnState } from "@telar/engine-client";
import { EngineApiError } from "@/platform/engine";
import { usePoll } from "@/ui/hooks/use-poll";
import { api } from "../api";

const REFRESH_MS = 15_000;

/** A session reads against `base` (an unanchored turn passes none); a canvas reads its project's `HEAD…worktree`. */
export function useDiffRead(sessionId: string | undefined, projectId: string | undefined, base: DiffBaseOption | undefined) {
  const [diff, setDiff] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const last = useRef<{ read: string; etag?: string }>(undefined);
  const load = useCallback(async () => {
    const read = `${sessionId}:${base?.base}:${base?.to}`;
    try {
      if (sessionId) {
        const status = await api.sessionGitStatus(sessionId, last.current?.read === read ? last.current.etag : undefined).catch(() => undefined);
        if (status?.unchanged) return;
        setDiff((await api.sessionDiff(sessionId, base ?? {})).diff);
        last.current = { read, ...(status?.etag ? { etag: status.etag } : {}) };
      } else if (projectId) setDiff((await api.projectDiff(projectId)).diff);
      else return;
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
    // `base` is rebuilt each render; its contents are what matter to the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId, base?.base, base?.to]);
  return { diff, error, load };
}

/** Re-reads on a timer and whenever the turn state changes, so a settling turn re-reads at once. */
export function useDiffRefresh(load: () => Promise<void>, active: TurnState | undefined) {
  const key = useMemo(() => ({ load, active }), [load, active]);
  usePoll(load, REFRESH_MS, { key });
}
