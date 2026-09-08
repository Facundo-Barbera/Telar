"use client";

/**
 * THE ONE PLACE THAT DECIDES A HUMAN SAW AN ANSWER.
 *
 * The rule itself is `lib/session-read-receipt.ts`; this is the browser half —
 * an IntersectionObserver on a marker rendered at the end of the newest result,
 * plus the two window facts the rule needs, plus the send.
 *
 * WHY A MARKER ELEMENT RATHER THAN A SCROLL POSITION: "is the reader at the
 * bottom" is a different question from "is the newest answer on screen". A
 * short answer under a long tool log, a viewport taller than the transcript, a
 * composer that grew as you typed — all move the bottom without moving the
 * answer. The element that IS the end of the answer can only be visible when
 * the answer is.
 *
 * WHY THE HOST IS CAPTURED, NOT LOOKED UP: the default engine api reads the
 * host out of the address bar AT CALL TIME, and this call is deliberately
 * delayed. A reader who opens a session on a paired Mac and then navigates
 * home would have the receipt land on the local engine — where that id is
 * either absent or, worse, another session entirely.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher } from "@/lib/hosts/client";
import {
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_SETTLE_MS,
  receiptRetryDelayMs,
  receiptToSend,
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
 * @param candidate The newest result turn, or `undefined` when there is none —
 *   passing one that is not the newest is what a delayed receipt would be.
 * @returns The ref to hang on the marker element that ends the newest answer.
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
  onRead: (session: Session) => void;
}): (node: HTMLElement | null) => void {
  const foreground = useForeground();
  const [atLatestResult, setAtLatestResult] = useState(false);
  /** The highest sequence this client has sent or is sending. A ref, because a
   *  render caused by it would be a render that changes nothing on screen. */
  const confirmed = useRef(0);
  /** Attempts spent on the run currently being sent — reset per turn, so a
   *  failed receipt does not spend the next one's budget. */
  const attempts = useRef(0);
  const attemptingRunId = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelled = useRef(false);
  /** Bumped by a failure, and the ONLY reason this is state: the retry has to
   *  re-run an effect whose other inputs did not change. */
  const [retries, setRetries] = useState(0);

  // A different session is a different high-water mark. Without this, opening
  // session B after reading A would treat B's turn 3 as already confirmed.
  useEffect(() => {
    confirmed.current = 0;
    attempts.current = 0;
    attemptingRunId.current = undefined;
  }, [sessionId, hostId]);

  const markerRef = useCallback((node: HTMLElement | null) => {
    if (!node || typeof IntersectionObserver === "undefined") {
      setAtLatestResult(false);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      setAtLatestResult(Boolean(entry?.isIntersecting));
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      setAtLatestResult(false);
    };
  }, []);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      clearTimeout(timer.current);
    };
  }, []);

  // THE READER LOOKING AGAIN IS A FRESH START. Without this, a turn whose
  // three attempts were spent while the engine was down could never be
  // confirmed again — the budget is meant to stop a retry loop, not to give up
  // on the session for good.
  useEffect(() => {
    if (foreground && atLatestResult) attempts.current = 0;
  }, [foreground, atLatestResult]);

  useEffect(() => {
    const pending = receiptToSend({
      ...(candidate ? { candidate } : {}),
      ...(readSequence === undefined ? {} : { readSequence }),
      confirmedSequence: confirmed.current,
      gate: { foreground, atLatestResult, loading },
    });
    if (!sessionId || !pending) return;
    if (attemptingRunId.current !== pending.runId) {
      attemptingRunId.current = pending.runId;
      attempts.current = 0;
    }
    if (attempts.current >= RECEIPT_MAX_ATTEMPTS) return;

    // CAPTURED, NOT READ LATER — see this file's header. Everything the send
    // needs is fixed at the moment the answer was on screen.
    const api = createEngineApi(hostFetcher(hostId));
    const forSession = sessionId;
    const runId = pending.runId;
    const sequence = pending.sequence;
    const delay = attempts.current === 0 ? RECEIPT_SETTLE_MS : receiptRetryDelayMs(attempts.current);

    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      attempts.current += 1;
      // The high-water mark moves BEFORE the request, so a re-render while it
      // is in flight does not send a second copy of the same receipt. A
      // failure below hands it back.
      const previous = confirmed.current;
      confirmed.current = Math.max(confirmed.current, sequence);
      api.markSessionRead(forSession, runId).then(
        (answer) => {
          if (cancelled.current) return;
          attempts.current = 0;
          onRead(answer.session);
        },
        () => {
          if (cancelled.current) return;
          confirmed.current = previous;
          // Try again on a backoff, up to `RECEIPT_MAX_ATTEMPTS`, and then stop
          // until the reader looks at the answer again. Silently: a receipt is
          // bookkeeping, and a banner about one would be noise about nothing
          // the reader can act on.
          setRetries((count) => count + 1);
        },
      );
    }, delay);
    return () => clearTimeout(timer.current);
    // `confirmed`/`attempts` are refs on purpose; the gate, the candidate and a
    // failed attempt are what may re-open a send.
  }, [sessionId, hostId, candidate, readSequence, foreground, atLatestResult, loading, retries, onRead]);

  return markerRef;
}

/**
 * The end of the newest answer, as an element.
 *
 * `aria-hidden` and zero-height: it is a position, not content. A screen
 * reader announcing "end of answer" would be reading out the implementation.
 */
export function ReadReceiptMarker({ markerRef }: { markerRef: (node: HTMLElement | null) => void }) {
  return <div ref={markerRef} aria-hidden className="h-px w-full shrink-0" data-read-receipt-marker="" />;
}
