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

import { useCallback, useEffect } from "react";
import { activeComposer } from "@/lib/composer-registry";
import { useCommandHandlers } from "@/lib/use-command-keys";
import type { DictationBox } from "./interim";
import { registerDictation, toggleActiveDictation } from "./registry";
import { useDictationSettings } from "./settings";
import { useDictation, type DictationState } from "./use-dictation";

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
};

export function useComposerDictation(token: string): ComposerDictation {
  // RESOLVED AT THE PRESS, not at render: "the active composer" is a question
  // whose answer changes with focus, and the hook asks it once per dictation.
  const box = useCallback((): DictationBox | undefined => activeComposer(), []);
  const dictation = useDictation({ box });
  const { provider } = useDictationSettings();
  const available = provider !== "off" && dictation.supported;
  const { toggle } = dictation;

  // THE COMPOSER'S OWN KEY, so the chord resolves "which box" through the
  // composer registry and lands on THIS dictation. Re-registered when `toggle`
  // changes identity (it closes over the phase), which is what keeps the
  // registry holding the live one rather than the first render's.
  useEffect(() => {
    if (!available) return;
    return registerDictation(token, { toggle });
  }, [token, available, toggle]);

  /**
   * BOUND ONLY WHILE IT COULD RUN, which is what keeps the command palette
   * honest: it asks whether a command is runnable before drawing a row, and a
   * "Dictate" row that did nothing would be exactly the dead row that rule
   * exists to prevent.
   *
   * THE HANDLER GOES BACK THROUGH THE REGISTRY rather than closing over this
   * composer's own toggle. With two composers mounted the newest binder wins,
   * and the newest binder is not necessarily the one being typed into — so the
   * function that is bound has to be the one that asks.
   */
  useCommandHandlers(available ? { "toggle-dictation": toggleActiveDictation } : {}, [available]);

  return { ...dictation, available };
}
