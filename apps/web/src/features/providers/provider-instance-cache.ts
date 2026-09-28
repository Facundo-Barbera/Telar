"use client";

import { useEffect, useState } from "react";
import { defaultInstanceIdForDriver, type ProviderDriverKind, type ProviderInstance } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";

const api = createEngineApi();

const PROVIDER_INSTANCES_CHANGED_EVENT = "telar:provider-instances";

export function announceProviderInstancesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROVIDER_INSTANCES_CHANGED_EVENT));
}

let cached: ProviderInstance[] | undefined;
let inFlight: Promise<ProviderInstance[]> | undefined;

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

function forgetProviderInstances(): void {
  cached = undefined;
}

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
