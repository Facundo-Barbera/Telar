"use client";

/**
 * THE LOGIN BEHIND A SESSION, FOR SURFACES THAT ONLY HAVE ITS ID.
 *
 * A session stores `providerInstanceId` and nothing else about the account it
 * runs as, which is right — the instance is a settings record and a transcript
 * should not carry a copy of one. But the composer now needs a field off that
 * record (this login's heavy-context threshold), and the cockpit is the wrong
 * place to fetch it per session: every open conversation would ask for the same
 * list.
 *
 * SO: ONE MODULE-LEVEL COPY, keyed by nothing. There is one list per cockpit
 * and it changes only when somebody edits it, so a cache with a key would be a
 * map with one entry. Concurrent callers share the in-flight request rather
 * than racing four identical GETs on a cold mount.
 *
 * NOT POLLED. The Providers section announces its own writes
 * (`announceProviderInstancesChanged`) in the DRAFTS_CHANGED_EVENT style from
 * composer-draft.ts: no payload, every listener re-reads, because the answer
 * from the engine is the only thing that is actually true. A timer here would
 * spend a request a minute to notice an edit that happens twice a year.
 */

import { useEffect, useState } from "react";
import { defaultInstanceIdForDriver, type ProviderDriverKind, type ProviderInstance } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";

/** THIS MACHINE'S LOGINS, which is the same scope the Providers pane edits.
 *  A cockpit looking at a remote host reads that host's sessions and this
 *  Mac's settings — the registry is not per-host today. */
const api = createEngineApi();

/** Same-window propagation, mirroring `composer-draft.ts`. `storage` does not
 *  fire in the tab that wrote, and settings and the cockpit are one document. */
export const PROVIDER_INSTANCES_CHANGED_EVENT = "telar:provider-instances";

export function announceProviderInstancesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROVIDER_INSTANCES_CHANGED_EVENT));
}

let cached: ProviderInstance[] | undefined;
let inFlight: Promise<ProviderInstance[]> | undefined;

/**
 * The list, from the cache or from the engine.
 *
 * A FAILED READ IS NOT CACHED. It answers with an empty list — every caller
 * here falls back to a default when it cannot find its instance — and leaves
 * the cache cold, so the next mount tries again rather than remembering that
 * the engine was unreachable once.
 */
function readProviderInstances(): Promise<ProviderInstance[]> {
  if (cached) return Promise.resolve(cached);
  const pending =
    inFlight ??
    api
      .providerInstances()
      .then((answer) => {
        cached = answer.providerInstances;
        return cached;
      })
      .catch((): ProviderInstance[] => [])
      .finally(() => {
        inFlight = undefined;
      });
  inFlight = pending;
  return pending;
}

/** Drop the copy so the next read goes to the engine. Exported for a test; the
 *  event above is how the app does it. */
export function forgetProviderInstances(): void {
  cached = undefined;
}

/**
 * One configured login, by the id a session stores.
 *
 * THE FALLBACK IS THE ENGINE'S OWN RULE, not a convenience: an id the registry
 * does not know resolves to the driver's built-in slot — which is what a
 * session created before the registry existed carries (`claude:default`), and
 * what happens when a custom instance is deleted out from under a live session.
 * See `ProviderInstance` in the contract. `driver` is a parameter because the
 * fallback cannot be derived from an id the registry has never heard of.
 *
 * `undefined` WHILE THE LIST IS IN FLIGHT, and the caller's default stands in
 * for that first paint. A threshold is not worth blocking a composer on.
 */
export function useProviderInstance(
  id: string | undefined,
  driver: ProviderDriverKind | undefined,
): ProviderInstance | undefined {
  const [instances, setInstances] = useState<ProviderInstance[] | undefined>(cached);

  useEffect(() => {
    let live = true;
    const load = () =>
      void readProviderInstances().then((next) => {
        if (live) setInstances(next);
      });
    load();
    const invalidate = () => {
      forgetProviderInstances();
      load();
    };
    window.addEventListener(PROVIDER_INSTANCES_CHANGED_EVENT, invalidate);
    return () => {
      live = false;
      window.removeEventListener(PROVIDER_INSTANCES_CHANGED_EVENT, invalidate);
    };
  }, []);

  if (!instances) return undefined;
  const named = instances.find((instance) => instance.id === id);
  if (named) return named;
  return driver ? instances.find((instance) => instance.id === defaultInstanceIdForDriver(driver)) : undefined;
}
