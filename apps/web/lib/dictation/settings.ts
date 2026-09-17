"use client";

/**
 * WHO DICTATES ON THIS MAC, AND WITH WHOSE KEY (#544).
 *
 * A HOOK RATHER THAN LOCAL STATE, for `useAgentSettings`' reason: the pane is
 * not the only surface that has to know — the mic button reads the provider to
 * decide whether to exist at all — and a same-window CustomEvent carries a
 * change across without either side polling a preference that moves twice a
 * year. Switching the provider on in settings makes the button appear on a
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
import type { DictationAnswer, DictationProviderId } from "@telar/engine-client";
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
  /** True until the engine has answered once. The row keeps its controls
   *  disabled until then rather than offering one that might be wrong. */
  loading: boolean;
  /** Both fields by presence. The key is WRITE-ONLY, and an empty string
   *  clears it, which is what Remove sends. */
  save: (patch: { provider?: DictationProviderId; apiKey?: string }) => Promise<void>;
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
 */
const NONE: DictationAnswer["dictation"] = { provider: "off", configured: false };

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

  const save = useCallback(async (patch: { provider?: DictationProviderId; apiKey?: string }) => {
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
