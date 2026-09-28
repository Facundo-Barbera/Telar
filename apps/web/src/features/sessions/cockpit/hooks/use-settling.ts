"use client";

import { useState } from "react";
import type { Session } from "@telar/engine-client";
import { asEngineError, createEngineApi } from "@/platform/engine";
import { useNow } from "@/ui/hooks/use-now";
import { hostFetcher } from "@/platform/engine/host-client";
import { useInboxPolicy } from "../../inbox-policy";
import { withSnooze } from "../../session-mutations";
import { isSettled, isSnoozed, settleEndedText, settlingActivityOf, terminalsClosedHint, type SettleableSession } from "../../session-settling";
import type { useSessionSync } from "./use-session-sync";

function settleableOf(session: Session): SettleableSession {
  return {
    archived: false,
    updatedAt: session.updatedAt,
    ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
    ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
    ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
    ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  };
}

/** Whether this session is settled or snoozed, on the rail's own rules, and the gestures that change it. */
export function useSettling(hostId: string, sessionId: string | undefined, { session, setSession, setError }: ReturnType<typeof useSessionSync>) {
  const now = useNow(30_000);
  const { policy: inboxPolicy } = useInboxPolicy();
  const settleable = session && settleableOf(session);
  const activity = settlingActivityOf(session ?? {});
  const settled = Boolean(session && settleable && session.state !== "archived" && isSettled(settleable, activity, { now, autoSettleAfterHours: inboxPolicy.autoSettleAfterHours }));
  const snoozedUntil = settleable && isSnoozed(settleable, activity, { now }) ? settleable.snoozedUntil : undefined;
  const [settleEnded, setSettleEnded] = useState<{ sessionId: string; text: string }>();
  const menuApi = createEngineApi(hostFetcher(hostId));

  // Clearing an override alone would not restart the clock on a session that settled by drifting.
  const unsettle = async () => {
    if (!sessionId) return;
    try {
      if (session?.settledOverride !== "settled") await menuApi.updateSession(sessionId, { settledOverride: "active" });
      const next = await menuApi.updateSession(sessionId, { settledOverride: null });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(asEngineError(cause, "Could not return the session to the list."));
    }
  };
  const patchFromMenu = async (patch: { settledOverride?: "settled" | "active" | null }, failure: string) => {
    if (!sessionId) return;
    try {
      const next = await menuApi.updateSession(sessionId, patch);
      setSession(next.session);
      const ended = settleEndedText(next.ended);
      setSettleEnded(ended ? { sessionId, text: ended } : undefined);
      setError(undefined);
    } catch (cause) {
      setError(asEngineError(cause, failure));
    }
  };
  const snooze = async (until: number | null) => {
    if (!sessionId || !session) return;
    const before = session;
    setSession(withSnooze(before, until));
    try {
      const next = await menuApi.updateSession(sessionId, { snoozedUntil: until });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      // Springs back to the record as it was, not as the guess left it.
      setSession(before);
      setError(asEngineError(cause, "Could not change the session's snooze."));
    }
  };
  const hint = session && terminalsClosedHint(session);
  const endedText = !settled ? undefined : settleEnded && settleEnded.sessionId === sessionId ? settleEnded.text : hint ? `${hint}.` : undefined;

  return { now, settled, snoozedUntil, endedText, unsettle, patchFromMenu, snooze, menuApi };
}
