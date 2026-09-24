"use client";

/**
 * WHO DICTATES ON THIS MAC, AND WITH WHOSE KEY (#544).
 *
 * A HOOK RATHER THAN LOCAL STATE: the pane is not the only surface that has
 * to know — the mic button reads the provider to decide whether to exist at
 * all — and a same-window CustomEvent carries a change across without either
 * side polling a preference that moves twice a year. Switching the provider on in settings makes the button appear on a
 * composer in another tab of this window without a reload.
 *
 * ENGINE STATE, NOT LOCAL STORAGE. Whether this Mac can dictate is a fact about
 * the machine: the desktop shell, a browser tab and a paired phone read one
 * engine, and a per-browser copy would mean a key pasted once per device.
 *
 * LOCAL-ONLY, like the Agent's. Settings is scoped to the local engine — there
 * is no `/hosts/<id>/settings` route to serve — so a host parameter here would
 * be one nothing could pass. The phone reaches the TOKEN route through the host
 * proxy; it does not paste the key from over there.
 */

import { useCallback, useEffect, useState } from "react";
import type { DictationAnswer, DictationLanguage, DictationProviderId } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

const CHANGED = "telar:dictation";

export type DictationSettingsHandle = {
  /** Who transcribes, or `off`. The mic button's whole existence hangs on
   *  this — see `components/dictation-button.tsx`. */
  provider: DictationProviderId;
  /** Whether this Mac holds a key. NEVER the key — see the engine's
   *  `dictation/credentials.ts`. Answered even while the provider is off,
   *  because a key pasted before is still there. */
  configured: boolean;
  /** What to transcribe, or `multi` for all of them at once (#560). The mic
   *  button does NOT read this — the language rides the token answer, so one
   *  round trip serves the press; it is here for the pane that sets it. */
  language: string;
  /** What may be chosen, named by the engine. Held there rather than here so
   *  no client carries a copy of a vendor's language table that goes stale the
   *  day the vendor adds one. */
  languages: DictationLanguage[];
  /** The person's own terms for the recogniser (#581), one per entry. The mic
   *  button does NOT read this either — the engine merges it with what this
   *  Mac is about and puts the result on the token — so it is here for the box
   *  that edits it. */
  vocabulary: string[];
  /** WHAT THE LAST PRESS ACTUALLY SENT (#712), when the engine has minted
   *  anything since it started. The provider shortens the glossary to fit its
   *  own budget, and this pane is where a person would come about it — see the
   *  note the Vocabulary row draws. Absent on an engine that predates the
   *  field, which `adopt` leaves alone rather than guessing at. */
  keyterms?: { built: number; sent: number; reason?: "refused" | "unconfirmed" };
  /** True until the engine has answered once. The row keeps its controls
   *  disabled until then rather than offering one that might be wrong. */
  loading: boolean;
  /** Every field by presence. The key is WRITE-ONLY, and an empty string
   *  clears it, which is what Remove sends. */
  save: (patch: { provider?: DictationProviderId; apiKey?: string; language?: string; vocabulary?: string[] }) => Promise<void>;
  /** The engine refused, or is not answering. Shown on the row rather than
   *  swallowed — the engine's answer is the state. */
  error?: string;
};

/**
 * OFF AND UNCONFIGURED IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE.
 *
 * Both halves matter and for different reasons. A first paint claiming a key is
 * saved would read as "somebody else set this up" for the length of one fetch.
 * A first paint claiming a provider is chosen would put a mic button on every
 * composer for that same moment and then take it away — a control that blinks
 * in and out on load is worse than one that arrives a beat late.
 *
 * AND AN EMPTY `languages` RATHER THAN A GUESSED LIST: the names belong to the
 * engine, so before it has answered there are none to offer. The picker is
 * disabled while `loading` either way.
 */
const NONE: DictationAnswer["dictation"] = { provider: "off", configured: false, language: "multi", languages: [], vocabulary: [] };

/**
 * THE ENGINE'S ANSWER OVER THE DEFAULTS, never adopted verbatim.
 *
 * An answer is a document that grows a field at a time — `language` and
 * `languages` in #560, `vocabulary` in #581 — and this pane is served by
 * whichever engine is on the machine, which after an update is briefly the old
 * one. A field the answer does not carry has to fall back to what it means when
 * nobody has said, rather than arriving as `undefined` in a control that will
 * call `.join` on it.
 */
const adopt = (answer: DictationAnswer): DictationAnswer["dictation"] => ({ ...NONE, ...answer.dictation });

export function useDictationSettings(): DictationSettingsHandle {
  const [dictation, setDictation] = useState(NONE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const api = createEngineApi();
    // Deferred a tick like every other loader here: setting state from an
    // effect BODY is the cascade this app's lint forbids.
    const task = window.setTimeout(() => {
      void api
        .dictation()
        .then((answer) => setDictation(adopt(answer)))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<DictationAnswer>).detail;
      if (next) setDictation(adopt(next));
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const save = useCallback(async (patch: { provider?: DictationProviderId; apiKey?: string; language?: string; vocabulary?: string[] }) => {
    try {
      const result = await createEngineApi().setDictation(patch);
      setDictation(adopt(result));
      setError(undefined);
      // Announced from what the ENGINE returned, never from what was sent: a
      // listener told the request rather than the outcome would show a change
      // that was refused.
      window.dispatchEvent(new CustomEvent<DictationAnswer>(CHANGED, { detail: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that change.");
    }
  }, []);

  return { ...dictation, loading, save, ...(error === undefined ? {} : { error }) };
}
