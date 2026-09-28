"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { revealState, revealText, stepReveal, type RevealState } from "@/ui/streaming-reveal";

const REDUCED = "(prefers-reduced-motion: reduce)";
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

const subscribeReduced = (onChange: () => void) => {
  const media = window.matchMedia(REDUCED);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const reducedNow = () => window.matchMedia(REDUCED).matches;
const notReducedOnTheServer = () => false;

export function isReplacement(rendered: string, shown: number, target: string): boolean {
  return !target.startsWith(revealText(rendered, shown));
}

export function useStreamingReveal(target: string, streaming: boolean): string {
  const reduced = useSyncExternalStore(subscribeReduced, reducedNow, notReducedOnTheServer);
  const paced = streaming && !reduced;
  const [reveal, setReveal] = useState<{ pace: RevealState; rendered: string }>(() => ({
    pace: revealState(target.length, now()),
    rendered: target,
  }));
  const { pace } = reveal;
  if (reveal.rendered !== target || (!paced && pace.shown < target.length)) {
    setReveal(
      !paced || isReplacement(reveal.rendered, reveal.pace.shown, target)
        ? { pace: revealState(target.length, now()), rendered: target }
        : { pace: stepReveal(reveal.pace, target.length, now()), rendered: target },
    );
  }

  const setPace = (next: (current: RevealState) => RevealState) =>
    setReveal((current) => ({ pace: next(current.pace), rendered: current.rendered }));

  useEffect(() => {
    if (!paced || pace.shown >= target.length) return;
    const frame = requestAnimationFrame(() => setPace((current) => stepReveal(current, target.length, now())));
    return () => cancelAnimationFrame(frame);
  }, [pace, paced, target]);

  if (!paced) return target;
  return revealText(target, pace.shown);
}
