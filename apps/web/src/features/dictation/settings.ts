"use client";

/**
 * Dictation settings live in the engine, not local storage, and are local-only
 * (no host route). A same-window CustomEvent lets the mic button in another tab
 * react to changes without polling.
 */

import { useCallback, useEffect, useState } from "react";
import type { DictationAnswer, DictationLanguage, DictationProviderId } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

const CHANGED = "telar:dictation";

export type DictationSettingsHandle = {
  provider: DictationProviderId;
  /** Whether this Mac holds a key; never the key itself. */
  configured: boolean;
  /** `multi` for automatic. The mic button reads language from the token answer instead. */
  language: string;
  languages: DictationLanguage[];
  /** One term per entry; the engine merges it into the token. */
  vocabulary: string[];
  /** What the last token actually sent after the provider trimmed the glossary. Absent on older engines. */
  keyterms?: { built: number; sent: number; reason?: "refused" | "unconfirmed" };
  /** True until the engine has answered once. */
  loading: boolean;
  /** Fields by presence. The key is write-only; "" clears it. */
  save: (patch: { provider?: DictationProviderId; apiKey?: string; language?: string; vocabulary?: string[] }) => Promise<void>;
  error?: string;
};

/** Off and unconfigured until the engine answers, so no mic button blinks in on load. */
const NONE: DictationAnswer["dictation"] = { provider: "off", configured: false, language: "multi", languages: [], vocabulary: [] };

/** Missing fields fall back to defaults: a just-updated app may briefly talk to an older engine. */
const adopt = (answer: DictationAnswer): DictationAnswer["dictation"] => ({ ...NONE, ...answer.dictation });

export function useDictationSettings(): DictationSettingsHandle {
  const [dictation, setDictation] = useState(NONE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const api = createEngineApi();
    // Deferred a tick: setting state in an effect body trips this app's lint.
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
      // Announce what the engine returned, not what was sent.
      window.dispatchEvent(new CustomEvent<DictationAnswer>(CHANGED, { detail: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that change.");
    }
  }, []);

  return { ...dictation, loading, save, ...(error === undefined ? {} : { error }) };
}
