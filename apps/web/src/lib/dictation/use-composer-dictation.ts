"use client";

/**
 * One dictation per composer, shared by the button and the ⌘D chord so they toggle the
 * same machine (see `registry.ts`). Also decides once whether dictation is available.
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
   * False when `dictation.provider` is `off` (the default) or the browser cannot record.
   * The button draws nothing and the chord does nothing, since system dictation already works here.
   */
  available: boolean;
  /**
   * Why the page stops recording when a provider is configured (insecure origin, no
   * `MediaRecorder`); `undefined` otherwise. Unlike `off`, this case is explained, not hidden.
   */
  unavailable?: string;
};

export function useComposerDictation(token: string): ComposerDictation {
  // Resolved at the press, since the active composer changes with focus.
  const box = useCallback((): DictationBox | undefined => activeComposer(), []);
  const dictation = useDictation({ box });
  const { provider } = useDictationSettings();
  const available = provider !== "off" && dictation.supported;
  /** `undefined` on the server and on any page that can record. */
  const pageRefuses = useMicrophoneUnavailable();
  const unavailable = provider !== "off" && !dictation.supported ? pageRefuses : undefined;

  /** Refusals raised by this hook carry their own counter, so `DictationNotice` shows each press. */
  const [refusal, setRefusal] = useState<{ text: string; seq: number }>();
  const refusals = useRef(0);
  /** Stable across renders, or the registry effect below would re-register on every keystroke. */
  const sayWhy = useCallback(() => {
    if (!unavailable) return;
    refusals.current += 1;
    setRefusal({ text: unavailable, seq: refusals.current });
  }, [unavailable]);

  /** Where the page cannot record, the registered toggle only explains why. */
  const toggle = unavailable ? sayWhy : dictation.toggle;
  /** An explanation is something to press, so the button and chord stay live in both states. */
  const offerable = available || unavailable !== undefined;

  // Re-registered when `toggle` changes identity so the registry holds the live one.
  useEffect(() => {
    if (!offerable) return;
    return registerDictation(token, { toggle });
  }, [token, offerable, toggle]);

  /**
   * Bound only while offerable, so the palette never shows a dead "Dictate" row. The handler
   * goes through the registry because with two composers the newest binder is not
   * necessarily the one being typed into.
   */
  useCommandHandlers(offerable ? { "toggle-dictation": toggleActiveDictation } : {}, [offerable]);

  return {
    ...dictation,
    available,
    ...(unavailable === undefined ? {} : { unavailable }),
    toggle,
    // Only when the page is the blocker; otherwise `useDictation`'s own error is the live one.
    ...(unavailable !== undefined && refusal !== undefined ? { error: refusal } : {}),
  };
}
