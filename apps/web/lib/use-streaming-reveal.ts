"use client";
import { useEffect, useState } from "react";
import { revealState, revealText, stepReveal, type RevealState } from "./streaming-reveal";

const REDUCED = "(prefers-reduced-motion: reduce)";
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * Whether `target` replaces what is on screen rather than continuing it.
 *
 * LENGTH CANNOT DETECT ONE: a revised answer of the same or greater length
 * would otherwise render a prefix of the NEW text using the OLD progress —
 * words in an order the model never wrote. Exported so the branch can be
 * tested without a DOM; the hook has no second copy of this rule.
 */
export function isReplacement(rendered: string, shown: number, target: string): boolean {
  return !target.startsWith(revealText(rendered, shown));
}

/**
 * Pace a growing string for display, without ever changing it.
 *
 * SEEDED AT THE FULL LENGTH: a surface switch remounts this hook, and starting
 * at zero would replay a reply the reader has already watched.
 *
 * ARRIVALS ARE STAMPED WHEN THE TEXT CHANGES, not when a frame runs. No frame
 * is scheduled while the pacer is caught up, so a frame callback cannot know
 * how long the gap before a chunk was.
 *
 * EVERY EXIT IS THE SOURCE TEXT — not streaming, reduced motion, replacement,
 * completion, stop.
 */
export function useStreamingReveal(target: string, streaming: boolean): string {
  /**
   * STATE, NOT REFS, AND ADJUSTED DURING RENDER.
   *
   * The paced position is rendered, so a ref would be read during render — the
   * case where React need not re-render and the text silently stops moving.
   * Ingesting in an effect instead cascades a second render per chunk. This is
   * React's own "adjusting state when a prop changes": compare against the
   * text this state was built for and re-derive in the same pass. `rendered`
   * travels with the pace so both are read as state, never as a ref.
   */
  const [reveal, setReveal] = useState<{ pace: RevealState; rendered: string }>(() => ({
    pace: revealState(target.length, now()),
    rendered: target,
  }));
  const { pace } = reveal;
  if (reveal.rendered !== target) {
    setReveal(
      isReplacement(reveal.rendered, reveal.pace.shown, target)
        ? { pace: revealState(target.length, now()), rendered: target }
        : { pace: stepReveal(reveal.pace, target.length, now()), rendered: target },
    );
  }

  const setPace = (next: (current: RevealState) => RevealState) =>
    setReveal((current) => ({ pace: next(current.pace), rendered: current.rendered }));

  useEffect(() => {
    if (!streaming || pace.shown >= target.length) return;
    if (typeof window === "undefined") return;
    const media = window.matchMedia(REDUCED);
    const flush = () => setPace(() => revealState(target.length, now()));
    // A LISTENER, NOT A SAMPLE: the preference can change with no new text, and
    // a frame that never runs cannot notice.
    if (media.matches) {
      flush();
      return;
    }
    media.addEventListener("change", flush);
    const frame = requestAnimationFrame(() => setPace((current) => stepReveal(current, target.length, now())));
    return () => {
      media.removeEventListener("change", flush);
      cancelAnimationFrame(frame);
    };
  }, [pace, streaming, target]);

  if (!streaming) return target;
  return revealText(target, pace.shown);
}
