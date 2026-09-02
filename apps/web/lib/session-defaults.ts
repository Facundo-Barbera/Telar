"use client";

/**
 * What a new session is built with when nobody said — shared by the two
 * surfaces that care: the settings pane that changes it, and the composer whose
 * workspace picker opens on it.
 *
 * A HOOK RATHER THAN LOCAL STATE, for the same reason `useInboxPolicy` is one:
 * two components need the live value, and the second of them is the composer,
 * which must not open on a stale answer after somebody has just changed the
 * setting in another pane. The same-window CustomEvent carries it across
 * without either side polling a preference that changes twice a year.
 *
 * ENGINE STATE, NOT LOCAL STORAGE. The engine itself reads this document on the
 * create path, so a per-browser copy would let the picker SHOW one thing and
 * the engine build another the moment a caller stayed quiet.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SESSION_DEFAULTS, type EnvMode, type SessionDefaults } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

const api = createEngineApi();

const CHANGED = "telar:session-defaults";

function announce(defaults: SessionDefaults): void {
  window.dispatchEvent(new CustomEvent<SessionDefaults>(CHANGED, { detail: defaults }));
}

export type SessionDefaultsHandle = {
  defaults: SessionDefaults;
  /** True until the engine has answered once. The composer seeds its draft off
   *  the first answer rather than the placeholder — see `useEffect` there. */
  loading: boolean;
  save: (patch: { envMode?: EnvMode }) => Promise<void>;
  /** The engine refused, or is not answering. */
  error?: string;
};

export function useSessionDefaults(): SessionDefaultsHandle {
  const [defaults, setDefaults] = useState<SessionDefaults>(DEFAULT_SESSION_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Deferred a tick like every other loader here: setting state from an
    // effect BODY is the cascade the lint rule forbids.
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

  const save = useCallback(async (patch: { envMode?: EnvMode }) => {
    try {
      const result = await api.setSessionDefaults(patch);
      setDefaults(result.sessionDefaults);
      setError(undefined);
      // Announced from what the ENGINE returned, never from what was sent — a
      // listener told the request rather than the outcome would seed its
      // composer on a value that was rejected.
      announce(result.sessionDefaults);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that default.");
    }
  }, []);

  return { defaults, loading, save, ...(error === undefined ? {} : { error }) };
}
