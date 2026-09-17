"use client";

/**
 * THE DICTATION KEY, FROM THE SETTINGS SIDE (#544).
 *
 * A HOOK RATHER THAN LOCAL STATE, for `useAgentSettings`' reason: the pane is
 * not the only surface that has to know — the mic button's refusal names this
 * row — and a same-window CustomEvent carries a change across without either
 * side polling a preference that moves twice a year.
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
import type { DictationAnswer } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

const CHANGED = "telar:dictation";

export type DictationSettingsHandle = {
  provider: "deepgram";
  /** Whether this Mac holds a key. NEVER the key — see the engine's
   *  `dictation/credentials.ts`. */
  configured: boolean;
  /** True until the engine has answered once. The row keeps its controls
   *  disabled until then rather than offering one that might be wrong. */
  loading: boolean;
  /** WRITE-ONLY. An empty string clears, which is what Remove sends. */
  save: (patch: { apiKey: string }) => Promise<void>;
  /** The engine refused, or is not answering. Shown on the row rather than
   *  swallowed — the engine's answer is the state. */
  error?: string;
};

/** NOT CONFIGURED IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE. A first
 *  paint claiming a key is saved would read as "somebody else set this up" for
 *  the length of one fetch. */
const NONE: DictationAnswer["dictation"] = { provider: "deepgram", configured: false };

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
        .then((answer) => setDictation(answer.dictation))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<DictationAnswer>).detail;
      if (next) setDictation(next.dictation);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const save = useCallback(async (patch: { apiKey: string }) => {
    try {
      const result = await createEngineApi().setDictation(patch);
      setDictation(result.dictation);
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
