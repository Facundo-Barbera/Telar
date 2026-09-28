"use client";

import { useCallback, useMemo } from "react";
import type { Session, Turn } from "@telar/engine-client";
import { newestResultTurn, type ReceiptAnswer, type ReceiptIdentity } from "../session-read-receipt";
import { useReadReceipt } from "../components/read-receipt";

/** The newest answer's read marker, and the read sequence it advances when the reader reaches it. */
export function useReadReceiptMarker({ hostId, sessionId, session, turns, loading, setSession }: {
  hostId: string;
  sessionId: string | undefined;
  session: Session | undefined;
  turns: Turn[];
  loading: boolean;
  setSession: (next: (current: Session | undefined) => Session | undefined) => void;
}) {
  const newestResult = useMemo(() => (session?.id === sessionId ? newestResultTurn(turns) : undefined), [session, sessionId, turns]);
  const onRead = useCallback(
    (identity: ReceiptIdentity, answer: ReceiptAnswer) => {
      if (identity.sessionId !== sessionId || identity.hostId !== hostId) return;
      setSession((current) => {
        if (!current || current.id !== identity.sessionId) return current;
        const next = answer.lastReadTurnSequence;
        if (next === undefined || next <= (current.lastReadTurnSequence ?? 0)) return current;
        return { ...current, lastReadTurnSequence: next, ...(answer.readAt === undefined ? {} : { readAt: answer.readAt }) };
      });
    },
    [sessionId, hostId, setSession],
  );
  const markerRefFor = useReadReceipt({
    ...(sessionId ? { sessionId } : {}),
    hostId,
    ...(newestResult ? { candidate: newestResult } : {}),
    ...(session?.lastReadTurnSequence === undefined ? {} : { readSequence: session.lastReadTurnSequence }),
    loading,
    onRead,
  });
  return { newestResult, markerRefFor };
}
