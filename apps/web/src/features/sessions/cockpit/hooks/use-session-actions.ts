"use client";

import { useState } from "react";
import type { RequestDecision, RuntimeMode } from "@telar/engine-client";
import { asEngineError, createEngineApi, newRunId } from "@/platform/engine";
import { sessionModelSelection, type ModelChoice } from "@/features/providers";
import type { useSessionSync } from "./use-session-sync";

const api = createEngineApi();

type SessionPatch = Parameters<typeof api.updateSession>[1];

/** The gestures on an existing session: each is a no-op on a fresh canvas and reports failure through `setError`. */
export function useSessionActions(sessionId: string | undefined, { session, hydrate, setSession, setError }: ReturnType<typeof useSessionSync>) {
  const [sending, setSending] = useState(false);

  const act = async (call: (id: string) => Promise<unknown>, failure: string, refreshOnFailure = false) => {
    if (!sessionId) return;
    setSending(true);
    try {
      await call(sessionId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      if (refreshOnFailure) await hydrate().catch(() => undefined);
      setError(asEngineError(cause, failure));
    } finally {
      setSending(false);
    }
  };

  const patch = async (body: SessionPatch, failure: string) => {
    if (!sessionId) return;
    try {
      const next = await api.updateSession(sessionId, body);
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(asEngineError(cause, failure));
    }
  };

  return {
    sending,
    setSending,
    stop: () => act((id) => api.stopSession(id), "Could not stop the session."),
    stopBackground: () => act((id) => api.stopBackgroundTasks(id), "Could not stop the background tasks."),
    // `kind: "compact"` makes it a gesture: the transcript draws a system row and the engine refuses a second.
    compact: () => act((id) => api.submitTurn(id, { runId: newRunId(), input: "/compact", kind: "compact" }), "Could not start the compaction."),
    decideRequest: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) =>
      act((id) => api.resolveRequest(id, requestId, { decision, ...(extra?.answers ? { answers: extra.answers } : {}) }), "Could not answer the approval."),
    resumeNow: (runId: string) => act((id) => api.resumeRateLimitedTurn(id, runId), "Could not resume that turn."),
    setResumeAfterRateLimit: (next: boolean) => patch({ resumeAfterRateLimit: next }, "Could not change that setting."),
    rename: (title: string) => patch({ title }, "Could not rename the session."),
    // `null`, not `undefined`: JSON drops an undefined key, and the engine would keep the old selection.
    setModel: async (next: ModelChoice) => {
      if (!session) return;
      await patch({ model: sessionModelSelection(session.providerInstanceId, next) ?? null }, "Could not change the model.");
    },
    // Not gated on `sending`: this is the brake.
    setRuntimeMode: (mode: RuntimeMode) => patch({ runtimeMode: mode }, "Could not change the runtime mode."),
  };
}
