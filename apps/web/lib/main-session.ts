"use client";

/**
 * WHICH CONVERSATION THIS MAC CALLS MAIN — shared by the settings pane that
 * changes it and, through the live read, by the rail that draws its entry.
 *
 * A HOOK RATHER THAN LOCAL STATE, for `useSessionDefaults`' reason: the pane is
 * not the only surface that has to know, and the same-window CustomEvent carries
 * a change across without either side polling a preference that moves twice a
 * year.
 *
 * THE RAIL DOES NOT USE THIS HOOK, and that is deliberate rather than an
 * oversight: it reads `mainSession` off the live-sessions answer it already
 * polls per host per tick, so the entry costs it no request of its own. What
 * this carries is the SETTINGS side — the read that fills the pane and the write
 * that designates. The announcement below is what lets the pane update itself
 * when a second pane in the same window changes it; the rail catches up on its
 * next poll, which is at most three seconds and needs no coordination.
 *
 * ENGINE STATE, NOT LOCAL STORAGE, for the sharper version of the reason
 * `useSessionDefaults` gives: this decides what one session on the machine is
 * TOLD, and a per-browser copy would mean a briefing some of this engine's own
 * clients had switched off.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_MAIN_SESSION, type MainSession, type MainSessionAnswer } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

const CHANGED = "telar:main-session";

/**
 * THE ANNOUNCEMENT NAMES ITS MAC, and a listener on another one ignores it.
 *
 * The event is window-global and a cockpit can hold two of these hooks at once
 * — the settings pane's (always this Mac's) and a `/hosts/<id>/main` screen's.
 * Without the id, designating a conversation here would have rewritten the
 * remote screen's idea of which conversation IT was showing.
 */
type Announcement = { hostId: string; answer: MainSessionAnswer };

function announce(hostId: string, answer: MainSessionAnswer): void {
  window.dispatchEvent(new CustomEvent<Announcement>(CHANGED, { detail: { hostId, answer } }));
}

/** Which rung answered, and whether the service refused it — never the key
 *  itself. See `MainSessionAnswer`. `undefined` is an engine too old to say,
 *  which the pane must not read as "no key". */
export type MainCredential = NonNullable<MainSessionAnswer["credential"]>;

export type MainSessionHandle = {
  main: MainSession;
  /** The key the assistant would run on, as far as the engine can tell. */
  credential?: MainCredential;
  /** True until the engine has answered once. The pane keeps the switch
   *  disabled until then rather than offering one that might be wrong. */
  loading: boolean;
  /** Designate, or switch it on or off. By presence, like the engine's own
   *  patch: naming a session must not also re-decide the switch. */
  save: (patch: { enabled?: boolean; sessionId?: string; model?: string }) => Promise<void>;
  /** The engine refused, or is not answering. Shown on the row rather than
   *  swallowed — the engine's answer is the state. */
  error?: string;
};

/**
 * `hostId` DEFAULTS TO THIS MAC, which is what every existing caller means: the
 * settings pane designates the coordinator of the cockpit you are sitting in,
 * never a paired Mac's. `/hosts/<id>/main` passes the Mac in the address bar,
 * and every call this hook makes is then routed there.
 */
export function useMainSession(hostId: string = LOCAL_HOST_ID): MainSessionHandle {
  /** OFF IS THE ANSWER UNTIL THE ENGINE GIVES A BETTER ONE. The opposite of
   *  `useSessionDefaults`' seeding and for the same reason: the default here is
   *  off, so a first paint showing it on would read as "Telar did this without
   *  asking" for the length of one fetch. */
  const [main, setMain] = useState<MainSession>(DEFAULT_MAIN_SESSION);
  const [credential, setCredential] = useState<MainCredential>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Rebuilt only when the Mac changes: a fetcher identity that moved every
  // render would re-run the loader below on every render.
  const api = useMemo(() => createEngineApi(hostFetcher(hostId)), [hostId]);

  useEffect(() => {
    // Deferred a tick like every other loader here: setting state from an
    // effect BODY is the cascade the lint rule forbids.
    const task = window.setTimeout(() => {
      void api
        .mainSession()
        .then((result) => {
          setMain(result.mainSession);
          setCredential(result.credential);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<Announcement>).detail;
      // ANOTHER MAC'S DESIGNATION IS NOT THIS SCREEN'S. Same window, two hooks,
      // two engines — see `Announcement`.
      if (!next || next.hostId !== hostId) return;
      setMain(next.answer.mainSession);
      setCredential(next.answer.credential);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, [api, hostId]);

  const save = useCallback(async (patch: { enabled?: boolean; sessionId?: string; model?: string }) => {
    try {
      const result = await api.setMainSession(patch);
      setMain(result.mainSession);
      // The same answer carries it, so the pane cannot draw a switched-on Main
      // beside a credential read from a different instant.
      setCredential(result.credential);
      setError(undefined);
      // Announced from what the ENGINE returned, never from what was sent: a
      // listener told the request rather than the outcome would show a
      // designation that was refused.
      announce(hostId, result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that change.");
    }
  }, [api, hostId]);

  return { main, loading, save, ...(credential === undefined ? {} : { credential }), ...(error === undefined ? {} : { error }) };
}
