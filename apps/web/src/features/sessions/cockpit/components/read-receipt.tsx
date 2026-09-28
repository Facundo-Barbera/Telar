"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, Turn } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";
import { hostVisible, subscribeHostVisibility } from "@/platform/desktop/host-visibility";
import { newestResultTurn, ReadReceiptCourier, type ReceiptAnswer, type ReceiptIdentity } from "../session-read-receipt";

function useForeground(): boolean {
  const [foreground, setForeground] = useState(false);
  useEffect(() => {
    const read = () => setForeground(hostVisible() && document.hasFocus());
    read();
    const unsubscribe = subscribeHostVisibility(read);
    window.addEventListener("focus", read);
    window.addEventListener("blur", read);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", read);
      window.removeEventListener("blur", read);
    };
  }, []);
  return foreground;
}

/** The newest answer's read marker, and the read sequence it advances when the reader reaches it. */
export function useReadReceipt({ hostId, sessionId, session, turns, loading, setSession }: {
  hostId: string;
  sessionId: string | undefined;
  session: Session | undefined;
  turns: Turn[];
  loading: boolean;
  setSession: (next: (current: Session | undefined) => Session | undefined) => void;
}) {
  const candidate = useMemo(() => (session?.id === sessionId ? newestResultTurn(turns) : undefined), [session, sessionId, turns]);
  const readSequence = session?.lastReadTurnSequence;
  const foreground = useForeground();
  const [visibleRunId, setVisibleRunId] = useState<string>();
  // Kept current without rebuilding the courier, which would lose what is in flight.
  const report = useRef<(identity: ReceiptIdentity, answer: ReceiptAnswer) => void>(() => undefined);
  useEffect(() => {
    report.current = (identity, answer) => {
      if (identity.sessionId !== sessionId || identity.hostId !== hostId) return;
      setSession((current) => {
        if (!current || current.id !== identity.sessionId) return current;
        const next = answer.lastReadTurnSequence;
        if (next === undefined || next <= (current.lastReadTurnSequence ?? 0)) return current;
        return { ...current, lastReadTurnSequence: next, ...(answer.readAt === undefined ? {} : { readAt: answer.readAt }) };
      });
    };
  });

  const courier = useRef<ReadReceiptCourier | undefined>(undefined);
  useEffect(() => {
    const created = new ReadReceiptCourier({
      send: (identity, runId) =>
        createEngineApi(hostFetcher(identity.hostId))
          .markSessionRead(identity.sessionId, runId)
          .then((answer) => answer.session),
      onRead: (identity, answer) => report.current(identity, answer),
      setTimer: (run, delayMs) => setTimeout(run, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    courier.current = created;
    return () => {
      created.dispose();
      courier.current = undefined;
    };
  }, []);

  const observers = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const markerRefFor = useCallback((runId: string) => {
    const existing = observers.current.get(runId);
    if (existing) return existing;
    const ref = (node: HTMLElement | null) => {
      if (!node || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        setVisibleRunId((current) => (entry?.isIntersecting ? runId : current === runId ? undefined : current));
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
        observers.current.delete(runId);
        setVisibleRunId((current) => (current === runId ? undefined : current));
      };
    };
    observers.current.set(runId, ref);
    return ref;
  }, []);

  useEffect(() => {
    courier.current?.update({
      ...(sessionId ? { identity: { sessionId, hostId } } : {}),
      ...(candidate ? { candidate } : {}),
      ...(readSequence === undefined ? {} : { readSequence }),
      gate: {
        foreground,
        // The candidate's own marker, never a previous answer's.
        atLatestResult: candidate !== undefined && visibleRunId === candidate.runId,
        loading,
      },
    });
  }, [sessionId, hostId, candidate, readSequence, foreground, visibleRunId, loading]);

  return { newestResult: candidate, markerRefFor };
}

export function ReadReceiptMarker({ markerRef }: { markerRef: (node: HTMLElement | null) => void }) {
  return <div ref={markerRef} aria-hidden className="h-px w-full shrink-0" data-read-receipt-marker="" />;
}
