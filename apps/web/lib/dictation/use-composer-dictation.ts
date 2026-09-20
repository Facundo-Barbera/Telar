"use client";

/**
 * ONE DICTATION PER COMPOSER, AND THE TWO WAYS TO PRESS IT (#588).
 *
 * THE HOOK MOVED UP, WHICH IS THE WHOLE CHANGE. `useDictation` used to be
 * called inside `DictationButton`; the button is now handed what this returns,
 * and the composer is where the machine lives. That is what lets the ⌘D command
 * and the button be one toggle — see `lib/dictation/registry.ts` for why a
 * second instance would be a second microphone.
 *
 * IT DECIDES WHETHER DICTATION IS AVAILABLE AT ALL, once, for both callers. The
 * button used to answer that question for itself (`provider === "off"`, then
 * `supported`) and return null; keeping it here means the chord refuses on
 * exactly the same two facts rather than on a copy of them that could drift.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { activeComposer } from "@/lib/composer-registry";
import { useCommandHandlers } from "@/lib/use-command-keys";
import type { DictationBox } from "./interim";
import { registerDictation, toggleActiveDictation } from "./registry";
import { useDictationSettings } from "./settings";
import { useDictation, useMicrophoneUnavailable, type DictationState } from "./use-dictation";

export type ComposerDictation = DictationState & {
  /**
   * WHETHER THERE IS ANYTHING TO OFFER HERE.
   *
   * False on a Mac where `dictation.provider` is `off` — which is every Mac by
   * default, and while the engine's answer is still in flight — and false where
   * the browser cannot record at all: an insecure origin, an embed with no
   * microphone permission, a browser without `MediaRecorder`.
   *
   * The button draws nothing and the chord does nothing. Not a DISABLED button
   * and not a beeping key: macOS dictation and Wispr Flow already work in this
   * box, so a control advertising a job the reader may have given to something
   * else is worse than no control.
   */
  available: boolean;
  /**
   * WHY THERE IS NOTHING TO OFFER, WHEN SOMEBODY DID ASK FOR IT (#639).
   *
   * A sentence when the provider is configured and the PAGE is what stops the
   * recording — an insecure origin, or a browser with no `MediaRecorder`.
   * `undefined` otherwise, which includes the case where dictation simply
   * works.
   *
   * ── WHY THIS IS NOT THE ARGUMENT ABOVE ALL OVER AGAIN ───────────────────
   * `available` collapses two refusals that deserve different treatment, and
   * silence is only right for one of them. `provider === "off"` is nobody
   * asking, and drawing nothing there is the whole point of the paragraph
   * above — it stays. An insecure origin is the opposite case: somebody set
   * dictation up on this Mac, it works when they are sitting at it, and it
   * vanishes without a word when they open the same cockpit from a phone over
   * the tailnet. A missing button is not a thing a person can act on; this
   * sentence names the cause and the way out.
   *
   * IT DOES NOT ADVERTISE A JOB TELAR CANNOT DO. The control it produces is
   * explicitly unavailable — it never claims it is about to record, and macOS
   * dictation in the same box is untouched.
   */
  unavailable?: string;
};

export function useComposerDictation(token: string): ComposerDictation {
  // RESOLVED AT THE PRESS, not at render: "the active composer" is a question
  // whose answer changes with focus, and the hook asks it once per dictation.
  const box = useCallback((): DictationBox | undefined => activeComposer(), []);
  const dictation = useDictation({ box });
  const { provider } = useDictationSettings();
  const available = provider !== "off" && dictation.supported;
  /** The page's own refusal, or nothing — `undefined` on the server and on any
   *  page that can record. Only interesting once somebody has asked for
   *  dictation, which is what `unavailable` below adds to it. */
  const pageRefuses = useMicrophoneUnavailable();
  const unavailable = provider !== "off" && !dictation.supported ? pageRefuses : undefined;

  /**
   * THE REFUSAL THIS HOOK RAISES ITSELF, rather than one from a dictation that
   * never started. `useDictation` counts the refusals it produces; this one
   * belongs to a press that could not reach it at all, so it carries its own
   * counter — and for the same reason `DictationState.error` does: two presses
   * that fail the same way are two pieces of news, and `DictationNotice` hides
   * itself on a `seq` it has already shown.
   */
  const [refusal, setRefusal] = useState<{ text: string; seq: number }>();
  const refusals = useRef(0);
  /** STABLE ACROSS RENDERS, like the toggle it stands in for: a fresh closure
   *  here would re-register this composer with the dictation registry on every
   *  keystroke, because the effect below holds whichever one is current. */
  const sayWhy = useCallback(() => {
    if (!unavailable) return;
    refusals.current += 1;
    setRefusal({ text: unavailable, seq: refusals.current });
  }, [unavailable]);

  /**
   * WHAT A PRESS DOES HERE — start a dictation, or explain why it cannot.
   *
   * ONE TOGGLE FOR BOTH, so the button's `onClick` and the chord's handler stay
   * exactly what they were and neither of them has to learn this distinction.
   * The substitution is the whole mechanism: where the page cannot record, the
   * thing registered under this composer's key is a function whose only job is
   * to say so.
   */
  const toggle = unavailable ? sayWhy : dictation.toggle;
  /** Offerable, not runnable: an explanation is something to press, so the
   *  button is drawn and the chord is bound in both states. */
  const offerable = available || unavailable !== undefined;

  // THE COMPOSER'S OWN KEY, so the chord resolves "which box" through the
  // composer registry and lands on THIS dictation. Re-registered when `toggle`
  // changes identity (it closes over the phase), which is what keeps the
  // registry holding the live one rather than the first render's.
  useEffect(() => {
    if (!offerable) return;
    return registerDictation(token, { toggle });
  }, [token, offerable, toggle]);

  /**
   * BOUND ONLY WHILE THERE IS SOMETHING TO OFFER, which is what keeps the
   * command palette honest: it asks whether a command is runnable before
   * drawing a row, and a "Dictate" row that did nothing would be exactly the
   * dead row that rule exists to prevent.
   *
   * `offerable` RATHER THAN `available` (#639). A row that answers the press
   * with "this page is not a secure context" is not a dead row — it is the
   * only place a person who pressed the chord and got silence would ever find
   * out why. What stays unbound is the case where nobody asked for dictation
   * at all.
   *
   * THE HANDLER GOES BACK THROUGH THE REGISTRY rather than closing over this
   * composer's own toggle. With two composers mounted the newest binder wins,
   * and the newest binder is not necessarily the one being typed into — so the
   * function that is bound has to be the one that asks.
   */
  useCommandHandlers(offerable ? { "toggle-dictation": toggleActiveDictation } : {}, [offerable]);

  return {
    ...dictation,
    available,
    ...(unavailable === undefined ? {} : { unavailable }),
    toggle,
    // THE REFUSAL THIS HOOK RAISED, WHERE THE BUTTON ALREADY LOOKS. Only when
    // the page is the blocker: in every other state `useDictation`'s own error
    // is the live one, and a stale explanation from a page that has since been
    // reloaded into a secure context would outrank it.
    ...(unavailable !== undefined && refusal !== undefined ? { error: refusal } : {}),
  };
}
