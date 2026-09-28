"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";
import { hostVisible, subscribeHostVisibility } from "@/platform/desktop/host-visibility";
import {
  ReadReceiptCourier,
  type ReceiptAnswer,
  type ReceiptIdentity,
  type ResultTurn,
} from "../session-read-receipt";

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

export function useReadReceipt({
  sessionId,
  hostId,
  candidate,
  readSequence,
  loading,
  onRead,
}: {
  sessionId?: string;
  hostId: string;
  candidate?: ResultTurn;
  readSequence?: number;
  loading: boolean;
  onRead: (identity: ReceiptIdentity, answer: ReceiptAnswer) => void;
}): (runId: string) => (node: HTMLElement | null) => void {
  const foreground = useForeground();
  /** which answer's marker is on screen — not whether one is. See the header. */
  const [visibleRunId, setVisibleRunId] = useState<string>();
  /** The callback the courier reaches out through, kept current without
   *  rebuilding the courier — which would lose what is in flight. Written in
   *  an effect, never during render. */
  const report = useRef(onRead);
  useEffect(() => {
    report.current = onRead;
  }, [onRead]);

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

  return markerRefFor;
}

export function ReadReceiptMarker({ markerRef }: { markerRef: (node: HTMLElement | null) => void }) {
  return <div ref={markerRef} aria-hidden className="h-px w-full shrink-0" data-read-receipt-marker="" />;
}
