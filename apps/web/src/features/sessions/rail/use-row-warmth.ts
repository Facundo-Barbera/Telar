"use client";

import { useEffect, useRef, useState } from "react";
import { claimPrefetch, PREFETCH_INTENT_MS, PREFETCH_MARGIN, releasePrefetch, warmConversation } from "./rail-prefetch";

export function useRowWarmth({
  rowKey,
  active,
  warmable,
  hostId,
  sessionId,
}: {
  rowKey: string;
  active: boolean;
  warmable: boolean;
  hostId: string | undefined;
  sessionId: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [warm, setWarm] = useState(false);
  const intent = useRef<number | undefined>(undefined);
  const restIntent = () => {
    if (intent.current === undefined) return;
    window.clearTimeout(intent.current);
    intent.current = undefined;
  };
  const beginIntent = () => {
    if (!warmable || warm || intent.current !== undefined) return;
    intent.current = window.setTimeout(() => {
      intent.current = undefined;
      if (claimPrefetch(rowKey, { active, intent: true })) setWarm(true);
    }, PREFETCH_INTENT_MS);
  };
  useEffect(() => restIntent, []);

  useEffect(() => {
    const node = rowRef.current;
    if (!warmable || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setWarm((current) => current || claimPrefetch(rowKey, { active }));
          else {
            releasePrefetch(rowKey);
            setWarm(false);
          }
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      releasePrefetch(rowKey);
    };
  }, [rowKey, active, warmable]);

  useEffect(() => {
    if (!warm || active) return;
    warmConversation(hostId, sessionId);
  }, [warm, active, hostId, sessionId]);

  return { rowRef, warm, beginIntent, restIntent };
}
