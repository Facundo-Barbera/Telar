"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProviderDriverKind } from "@telar/engine-client";
import {
  modelLabel,
  type ModelChoice,
  keepStarredVisible,
  orderByFavorite,
  splitGenerations,
  familyFavorites,
  groupFamilies,
  pickInFamily,
  toggleFamilyFavorite,
  visibleModels,
  type ModelFamily,
  importLocalFavorites,
  patchModelOverlay,
  useModelCatalogues,
  useModelOverlays,
  connectionLabel,
  familySearchText,
  routeOf,
  routedModelLabel,
} from "@/features/providers";
import { PROVIDERS, searchScope, selectionOf, withModel } from "../model-options";

/** One provider's models, or the starred ones across providers. */
export type ModelView = ProviderDriverKind | "favorites";

export type ModelPickerProps = {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  /** Whose login's curated list to show; absent means the driver's built-in slot. */
  instanceId?: string;
  /** Absent before the session exists: the fresh canvas has nothing to patch. */
  onChange?: (next: ModelChoice) => void;
  /** Absent once the session exists, which fixes the provider. */
  onDriverChange?: (driver: ProviderDriverKind) => void;
};

export function useModelPicker({ driver, choice, instanceId, onChange, onDriverChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  // A live query replaces every scope the rail selects: the legacy fold, favourites and the provider.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const [view, setView] = useState<ModelView>(driver);
  // Other providers are read only while the provider can still be switched; each read spawns a subprocess.
  const crossProvider = (view === "favorites" || searching) && Boolean(onDriverChange);
  const scopes = crossProvider
    ? PROVIDERS.map((option) => (option === driver && instanceId ? { driver: option, instanceId } : { driver: option }))
    : [{ driver, ...(instanceId ? { instanceId } : {}) }];
  const catalogues = useModelCatalogues(scopes);
  const catalogue = catalogues.get(driver);
  const models = catalogue?.models ?? [];
  const { family: selectedFamily, window: activeWindow, defaultEffort } = selectionOf(models, choice);
  const overlays = useModelOverlays(scopes);
  const starredRows = overlays.get(driver)?.favorites ?? [];
  const favorites = useMemo(() => {
    const out = new Set<string>();
    for (const option of crossProvider ? PROVIDERS : [driver]) {
      const rows = new Set(overlays.get(option)?.favorites ?? []);
      for (const id of familyFavorites(catalogues.get(option)?.models ?? [], rows)) out.add(id);
    }
    return out;
  }, [overlays, catalogues, crossProvider, driver]);

  const overlayLoaded = overlays.get(driver) !== undefined;
  useEffect(() => {
    if (!overlayLoaded || models.length === 0) return;
    const task = window.setTimeout(() => {
      void importLocalFavorites(instanceId ?? driver, models, starredRows);
    }, 0);
    return () => window.clearTimeout(task);
    // The import guards itself per login; depending on `starredRows` would re-run it on its own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayLoaded, models.length, instanceId, driver]);

  const starFamily = (from: ProviderDriverKind, familyId: string) => {
    const rows = catalogues.get(from)?.models ?? [];
    const owner = from === driver ? (instanceId ?? driver) : from;
    const next = toggleFamilyFavorite(rows, overlays.get(from)?.favorites ?? [], familyId);
    void patchModelOverlay(owner, { favorites: next }).catch(() => undefined);
  };

  // The listing hides curated-away rows but keeps the running one; the selection above reads the full catalogue.
  const listedOf = (option: ProviderDriverKind) => groupFamilies(visibleModels(catalogues.get(option)?.models ?? [], choice.model));
  const { current, legacy } = keepStarredVisible(splitGenerations(listedOf(driver)), favorites);
  const matches = (family: ModelFamily) => familySearchText(family).includes(query.trim().toLowerCase());
  const scope = searchScope(driver, crossProvider);
  const searchable = (option: ProviderDriverKind) => (option === driver ? [...current, ...legacy] : listedOf(option));
  const listed: { from: ProviderDriverKind; family: ModelFamily }[] = searching
    ? scope.flatMap((option) => searchable(option).filter(matches).map((family) => ({ from: option, family })))
    : view === "favorites"
      ? scope.flatMap((option) => listedOf(option).filter((family) => favorites.has(family.id)).map((family) => ({ from: option, family })))
      : orderByFavorite(showLegacy ? [...current, ...legacy] : current, favorites).map((family) => ({ from: driver, family }));
  const asking = scope.find((option) => !catalogues.get(option));

  const showView = (onto: ModelView) => {
    setView(onto);
    setShowLegacy(false);
    setQuery("");
  };
  // Every close lands the next open on the models you can run.
  const close = (onto: ModelView) => {
    setOpen(false);
    showView(onto);
  };

  // A cross-provider pick sends the model alone: effort and fast mode are the old provider's vocabulary.
  const pickFamily = (family: ModelFamily, from: ProviderDriverKind) => {
    const row = pickInFamily(family, activeWindow);
    if (from === driver) onChange?.(withModel(choice, row));
    else {
      onDriverChange?.(from);
      onChange?.({ model: row.id });
    }
    close(from);
  };

  const pillRoute = routeOf(selectedFamily?.id ?? choice.model ?? "");
  const label = pillRoute
    ? `${routedModelLabel(pillRoute.model)} · ${connectionLabel(pillRoute.connection)}`
    : (selectedFamily?.label ?? modelLabel(models, choice.model));

  return {
    open,
    setOpen,
    close,
    query,
    setQuery,
    searching,
    view,
    showView,
    showLegacy,
    setShowLegacy,
    crossProvider,
    catalogue,
    models,
    selectedFamily,
    defaultEffort,
    favorites,
    legacy,
    listed,
    asking,
    starFamily,
    pickFamily,
    label,
  };
}

export type ModelPicker = ReturnType<typeof useModelPicker>;
