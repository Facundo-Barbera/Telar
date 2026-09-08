"use client";

/**
 * THE ONE PLACE THAT DECIDES A HUMAN SAW AN ANSWER — the browser half.
 *
 * The rule is `lib/session-read-receipt.ts`: `receiptToSend` for "should this
 * render confirm anything", and `ReadReceiptCourier` for everything that can go
 * wrong afterwards (a request outliving its session, its host, or a later
 * receipt). What is left here is genuinely browser-shaped: an
 * IntersectionObserver on a marker at the end of the newest answer, and the two
 * window facts that say somebody is in front of it.
 *
 * WHY A MARKER ELEMENT RATHER THAN A SCROLL POSITION: "is the reader at the
 * bottom" is a different question from "is the newest answer on screen". A
 * short answer under a long tool log, a viewport taller than the transcript, a
 * composer that grew as you typed — all move the bottom without moving the
 * answer. The element that IS the end of the answer can only be visible when
 * the answer is.
 *
 * WHY THE MARKER IS KEYED BY RUN ID: visibility must never be INHERITED across
 * answers. A marker that was on screen for turn 5 says nothing about turn 6,
 * and a boolean would have carried the old answer's "yes" into the new one's
 * first render — confirming a turn nobody had seen yet. What is stored is
 * WHICH run's marker is visible, so a new candidate is unseen until its own
 * marker reports.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher } from "@/lib/hosts/client";
import {
  ReadReceiptCourier,
  type ReceiptAnswer,
  type ReceiptIdentity,
  type ResultTurn,
} from "@/lib/session-read-receipt";

/**
 * Is a person actually looking at this window?
 *
 * BOTH HALVES. `visibilityState` alone says a background tab is hidden but
 * calls an unfocused window in the corner of a second monitor visible, and
 * `hasFocus` alone is true for a tab whose window is focused while another tab
 * is showing. Neither is enough on its own and both are one listener.
 */
function useForeground(): boolean {
  const [foreground, setForeground] = useState(false);
  useEffect(() => {
    const read = () => setForeground(document.visibilityState === "visible" && document.hasFocus());
    read();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("blur", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("blur", read);
    };
  }, []);
  return foreground;
}

/**
 * Send a receipt when the newest answer has been on screen, in a foreground
 * window, for a beat.
 *
 * @param candidate The newest result turn, or `undefined` when there is none.
 * @param onRead Given the identity the receipt was RAISED under, so the caller
 *   can refuse an answer about a session it is no longer showing. The courier
 *   already drops stale ones; passing it on keeps the caller honest too.
 * @returns `markerRefFor(runId)` — the ref to hang on the marker that ends that
 *   turn. Only the newest result's marker is ever rendered.
 */
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
  /** WHICH answer's marker is on screen — not whether one is. See the header. */
  const [visibleRunId, setVisibleRunId] = useState<string>();
  /** The callback the courier reaches out through, kept current without
   *  rebuilding the courier — which would lose what is in flight. Written in
   *  an effect, never during render. */
  const report = useRef(onRead);
  useEffect(() => {
    report.current = onRead;
  }, [onRead]);

  /**
   * ONE COURIER FOR THE LIFE OF THE MOUNT, built in an effect rather than a
   * memo: it owns in-flight requests and timers, so it is a subscription, not
   * a derived value. Declared BEFORE the effect that drives it, so it exists
   * by the time that one first runs.
   */
  const courier = useRef<ReadReceiptCourier | undefined>(undefined);
  useEffect(() => {
    const created = new ReadReceiptCourier({
      // CAPTURED PER REQUEST, NOT READ WHEN IT LANDS. The default engine api
      // resolves its host from the address bar at call time, and this call is
      // deliberately delayed — a reader who opens a paired Mac's session and
      // then navigates home would otherwise send the receipt to the local
      // engine, where that id is absent or, worse, another session.
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
        // Only ever claims or releases ITS OWN run, so a marker unmounting
        // cannot blank the answer that replaced it.
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
        // The candidate's OWN marker, never a previous answer's.
        atLatestResult: candidate !== undefined && visibleRunId === candidate.runId,
        // NEVER MID-HYDRATE: what is on screen during a load is the previous
        // render, or nothing at all.
        loading,
      },
    });
  }, [sessionId, hostId, candidate, readSequence, foreground, visibleRunId, loading]);

  return markerRefFor;
}

/**
 * The end of one answer, as an element.
 *
 * `aria-hidden` and zero-height: it is a position, not content. A screen
 * reader announcing "end of answer" would be reading out the implementation.
 */
export function ReadReceiptMarker({ markerRef }: { markerRef: (node: HTMLElement | null) => void }) {
  return <div ref={markerRef} aria-hidden className="h-px w-full shrink-0" data-read-receipt-marker="" />;
}
