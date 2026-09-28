"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SESSION_DEFAULTS, type SessionDefaults, type SessionDefaultsPatch } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";

const api = createEngineApi();

const CHANGED = "telar:session-defaults";

function announce(defaults: SessionDefaults): void {
  window.dispatchEvent(new CustomEvent<SessionDefaults>(CHANGED, { detail: defaults }));
}

export type SessionDefaultsHandle = {
  defaults: SessionDefaults;
  loading: boolean;
  save: (patch: SessionDefaultsPatch) => Promise<void>;
  error?: string;
};

export function useSessionDefaults(): SessionDefaultsHandle {
  const [defaults, setDefaults] = useState<SessionDefaults>(DEFAULT_SESSION_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const task = window.setTimeout(() => {
      void api
        .sessionDefaults()
        .then((result) => setDefaults(result.sessionDefaults))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<SessionDefaults>).detail;
      if (next) setDefaults(next);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const save = useCallback(async (patch: SessionDefaultsPatch) => {
    try {
      const result = await api.setSessionDefaults(patch);
      setDefaults(result.sessionDefaults);
      setError(undefined);
      announce(result.sessionDefaults);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that default.");
    }
  }, []);

  return { defaults, loading, save, ...(error === undefined ? {} : { error }) };
}
