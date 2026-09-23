"use client";

/**
 * THE CATALOGUE, FETCHED ONCE PER LOGIN PER PAGE.
 *
 * MODULE SCOPE, NOT COMPONENT STATE. Several controls need it — the model
 * picker, the reasoning menu, the overflow, the `/` command list — and the read
 * is a subprocess spawn on the engine's side. One promise per login, shared,
 * means opening a popover never costs a second one.
 *
 * KEYED BY LOGIN, NOT BY DRIVER, and that is a correctness fix rather than a
 * refinement: two logins of one provider curate the same harness differently, so
 * a single entry per driver would serve the first login's hidden rows to the
 * second one.
 *
 * FORGETTABLE, which the old module-local map was not. A curated list is edited
 * in a DIFFERENT ROUTE of the same app, so a page-lifetime promise cache is the
 * one thing standing between hiding a model in Settings and seeing it gone in
 * the composer. `forgetModelCatalogues` is what the Models tab calls after an
 * accepted write; the generation counter is what makes every mounted hook
 * re-read without any of them importing the settings pane.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CustomProviderModel, ModelCatalogue, ModelOverlay, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { familyKey } from "@/lib/model-families";
import { readFavorites } from "@/lib/model-favorites";

/** Which list to read: a provider, and whose login's view of it. An absent
 *  instance means that driver's built-in slot, which is what the engine falls
 *  back to as well. */
export type ModelTarget = { driver: ProviderDriverKind; instanceId?: string };

const api = createEngineApi();
const catalogues = new Map<string, Promise<ModelCatalogue>>();

let generation = 0;
const listeners = new Set<() => void>();

const keyOf = (target: ModelTarget): string => `${target.driver}:${target.instanceId ?? ""}`;

/** Drop every cached answer and wake every mounted reader. Called after an
 *  accepted overlay write — never on a timer, and never speculatively. */
export function forgetModelCatalogues(): void {
  catalogues.clear();
  overlays.clear();
  generation += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The counter, as a React-visible store. `0` on the server, where there is no
 *  cache to have been invalidated. */
export function useModelCatalogueGeneration(): number {
  return useSyncExternalStore(
    subscribe,
    () => generation,
    () => 0,
  );
}

/**
 * ASKS FOR THE ONES IT IS GIVEN, AND NO OTHERS.
 *
 * Reading a catalogue SPAWNS A SUBPROCESS on the engine's side, so which logins
 * this is called with is a real cost rather than a detail. The session's own
 * provider is asked on mount, because the pill has to be able to say which model
 * is running without being opened. Every other provider is asked only when
 * something needs it — today that is the favourites view, which spans providers
 * and is reached by pressing the star.
 */
export function useModelCatalogues(targets: readonly ModelTarget[]): ReadonlyMap<ProviderDriverKind, ModelCatalogue> {
  const [loaded, setLoaded] = useState<ReadonlyMap<ProviderDriverKind, ModelCatalogue>>(new Map());
  const epoch = useModelCatalogueGeneration();
  // The dependency is the JOINED LIST, not the array: the caller rebuilds the
  // array every render and an identity dependency would re-run this forever.
  const wanted = targets.map((target) => keyOf(target)).join(",");
  useEffect(() => {
    let cancelled = false;
    // Deferred, like every other read in this app that the server could not
    // have performed.
    const task = window.setTimeout(() => {
      for (const key of wanted.split(",").filter(Boolean)) {
        const [driver, instanceId] = key.split(":") as [ProviderDriverKind, string];
        let pending = catalogues.get(key);
        if (!pending) {
          pending = api.modelCatalogue(driver, instanceId ? { instanceId } : {}).then((result) => result.catalogue);
          catalogues.set(key, pending);
          // A failed read must not poison the cache — the next popover should
          // try again rather than inherit the error for the life of the page.
          void pending.catch(() => catalogues.delete(key));
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

/* ------------------------------------------------------------------ overlays */

const overlays = new Map<string, Promise<ModelOverlay>>();

/** Same shape and same lifetime as the catalogue cache above, and cleared by the
 *  same call — a menu reads the two together and must never hold one half from
 *  before an edit and one half from after. */
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

/** Write, then forget — so the next read of either half is the engine's answer
 *  rather than the one this page started with. */
export async function patchModelOverlay(
  instanceId: string,
  patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
): Promise<void> {
  await api.setModelOverlay(instanceId, patch);
  forgetModelCatalogues();
}

/**
 * THE STARS SOMEBODY ALREADY HAD, moved to where the Models tab can see them.
 *
 * Favourites used to live in this browser's `localStorage`, keyed by family id,
 * and that was the right call while a star was the ONLY user fact about a model:
 * it changed how a menu sorted and nothing about what ran. The Models tab ends
 * that — a star now sits in the same row as a hide and an added id, which are
 * engine facts by necessity, and two stores behind one row is how "I unstarred
 * it and it came back" happens.
 *
 * ONCE PER LOGIN PER BROWSER, guarded by a sentinel, and ADDITIVE: it unions the
 * expanded row ids into whatever the overlay already holds. Without the sentinel
 * an unstar in Settings would be undone by the next page load; without the union
 * it would clobber stars set on another device.
 *
 * BEST EFFORT IN EVERY DIRECTION. A failure here costs the stars, which is the
 * gesture the `:v2` key bump already established as survivable — it must never
 * cost the picker.
 */
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
    // Family ids expand to the row ids that family covers IN THIS catalogue —
    // a star for a model this login does not have simply finds nothing.
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
