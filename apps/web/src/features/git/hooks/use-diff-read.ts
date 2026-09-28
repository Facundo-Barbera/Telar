"use client";

import { useCallback, useEffect, useState } from "react";
import type { DiffBaseOption, SessionDiff, TurnState } from "@telar/engine-client";
import { EngineApiError } from "@/lib/engine/client";
import { api } from "../api";

const REFRESH_MS = 15_000;

/** A session reads against `base` (an unanchored turn passes none); a canvas reads its project's `HEAD…worktree`. */
export function useDiffRead(sessionId: string | undefined, projectId: string | undefined, base: DiffBaseOption | undefined) {
  const [diff, setDiff] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      if (sessionId) setDiff((await api.sessionDiff(sessionId, base ?? {})).diff);
      else if (projectId) setDiff((await api.projectDiff(projectId)).diff);
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
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load, active]);
}
