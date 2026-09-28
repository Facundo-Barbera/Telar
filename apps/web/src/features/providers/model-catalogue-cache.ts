"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CustomProviderModel, ModelCatalogue, ModelOverlay, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { familyKey } from "./model-families";
import { readFavorites } from "./model-favorites";

export type ModelTarget = { driver: ProviderDriverKind; instanceId?: string };

const api = createEngineApi();
const catalogues = new Map<string, Promise<ModelCatalogue>>();

let generation = 0;
const listeners = new Set<() => void>();

const keyOf = (target: ModelTarget): string => `${target.driver}:${target.instanceId ?? ""}`;

export function forgetModelCatalogues(): void {
  catalogues.clear();
  overlays.clear();
  generation += 1;
  for (const listener of listeners) listener();
}

const FOLLOW_MS = 1_500;
const FOLLOW_TRIES = 8;

function readCatalogue(key: string, driver: ProviderDriverKind, instanceId: string, tries = 0): Promise<ModelCatalogue> {
  const pending = api.modelCatalogue(driver, instanceId ? { instanceId } : {}).then((result) => result.catalogue);
  catalogues.set(key, pending);
  void pending.catch(() => {
    if (catalogues.get(key) === pending) catalogues.delete(key);
  });
  void pending
    .then((first) => {
      if (!first.refreshing || tries >= FOLLOW_TRIES || typeof window === "undefined") return;
      window.setTimeout(() => {
        if (catalogues.get(key) !== pending) return;
        void api
          .modelCatalogue(driver, instanceId ? { instanceId } : {})
          .then(({ catalogue: next }) => {
            if (catalogues.get(key) !== pending) return;
            if (next.refreshing) {
              void readCatalogue(key, driver, instanceId, tries + 1);
              return;
            }
            if (next.readAt === first.readAt) return;
            catalogues.set(key, Promise.resolve(next));
            generation += 1;
            for (const listener of listeners) listener();
          })
          .catch(() => undefined);
      }, FOLLOW_MS);
    })
    .catch(() => undefined);
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useModelCatalogueGeneration(): number {
  return useSyncExternalStore(
    subscribe,
    () => generation,
    () => 0,
  );
}

export function useModelCatalogues(targets: readonly ModelTarget[]): ReadonlyMap<ProviderDriverKind, ModelCatalogue> {
  const [loaded, setLoaded] = useState<ReadonlyMap<ProviderDriverKind, ModelCatalogue>>(new Map());
  const epoch = useModelCatalogueGeneration();
  const wanted = targets.map((target) => keyOf(target)).join(",");
  useEffect(() => {
    let cancelled = false;
    const task = window.setTimeout(() => {
      for (const key of wanted.split(",").filter(Boolean)) {
        const [driver, instanceId] = key.split(":") as [ProviderDriverKind, string];
        let pending = catalogues.get(key);
        if (!pending) {
          pending = readCatalogue(key, driver, instanceId);
        }
        void pending
          .then((result) => {
            if (cancelled) return;
            setLoaded((current) => (current.get(driver) === result ? current : new Map(current).set(driver, result)));
          })
          .catch(() => undefined);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [wanted, epoch]);
  return loaded;
}

export function useModelCatalogue(driver: ProviderDriverKind, instanceId?: string): ModelCatalogue | undefined {
  return useModelCatalogues([{ driver, ...(instanceId ? { instanceId } : {}) }]).get(driver);
}

const overlays = new Map<string, Promise<ModelOverlay>>();

export function useModelOverlays(targets: readonly ModelTarget[]): ReadonlyMap<ProviderDriverKind, ModelOverlay> {
  const [loaded, setLoaded] = useState<ReadonlyMap<ProviderDriverKind, ModelOverlay>>(new Map());
  const epoch = useModelCatalogueGeneration();
  const wanted = targets.map((target) => keyOf(target)).join(",");
  useEffect(() => {
    let cancelled = false;
    const task = window.setTimeout(() => {
      for (const key of wanted.split(",").filter(Boolean)) {
        const [driver, instanceId] = key.split(":") as [ProviderDriverKind, string];
        let pending = overlays.get(key);
        if (!pending) {
          pending = api.modelOverlay(instanceId || driver).then((result) => result.overlay);
          overlays.set(key, pending);
          void pending.catch(() => overlays.delete(key));
        }
        void pending
          .then((result) => {
            if (cancelled) return;
            setLoaded((current) => (current.get(driver) === result ? current : new Map(current).set(driver, result)));
          })
          .catch(() => undefined);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [wanted, epoch]);
  return loaded;
}

export async function patchModelOverlay(
  instanceId: string,
  patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
): Promise<void> {
  await api.setModelOverlay(instanceId, patch);
  forgetModelCatalogues();
}

export async function importLocalFavorites(
  instanceId: string,
  models: readonly ProviderModel[],
  current: readonly string[],
): Promise<string[] | undefined> {
  const sentinel = `telar:favorite-models:migrated:${instanceId}`;
  try {
    if (typeof window === "undefined" || window.localStorage.getItem(sentinel)) return undefined;
    const stored = readFavorites();
    window.localStorage.setItem(sentinel, "1");
    if (stored.size === 0) return undefined;
    const merged = new Set(current);
    for (const model of models) if (stored.has(familyKey(model))) merged.add(model.id);
    if (merged.size === current.length) return undefined;
    const favorites = [...merged];
    await patchModelOverlay(instanceId, { favorites });
    return favorites;
  } catch {
    return undefined;
  }
}
