"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { revealState, revealText, stepReveal, type RevealState } from "./streaming-reveal";

const REDUCED = "(prefers-reduced-motion: reduce)";
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * READ DURING RENDER, NOT IN AN EFFECT.
 *
 * An effect runs AFTER the paint, so honouring the preference there is always
 * one frame late: the commit before it holds the paced prefix — for a first
 * chunk, the empty string — and a reader who asked for no motion still watches
 * the text arrive a frame behind every chunk. `useSyncExternalStore` answers in
 * the render that produces the text, and still notifies when the preference
 * changes with no new text, which a sample could not.
 */
const subscribeReduced = (onChange: () => void) => {
  const media = window.matchMedia(REDUCED);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const reducedNow = () => window.matchMedia(REDUCED).matches;
const notReducedOnTheServer = () => false;

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
  const reduced = useSyncExternalStore(subscribeReduced, reducedNow, notReducedOnTheServer);
  /**
   * ONE CONDITION FOR "is anything being paced", so the state, the frame and
   * the returned text cannot disagree about it. Reduced motion is not a second
   * kind of exit: it is the same exit completion and Stop take.
   */
  const paced = streaming && !reduced;
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
  /**
   * A PACE LEFT BEHIND BY AN EXIT IS CAUGHT UP, NOT FROZEN PART WAY. Whatever
   * ends the pacing — completion, Stop, reduce — shows the whole text, so the
   * position that goes with it is the whole text. Leaving a partial one would
   * rewind the reader's screen the moment pacing resumed: the reduce toggled
   * back off during a reply, the turn that streams again after settling.
   */
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
