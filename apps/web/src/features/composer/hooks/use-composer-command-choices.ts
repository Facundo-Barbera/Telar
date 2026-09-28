"use client";

import { useMemo } from "react";
import type { ProviderDriverKind } from "@telar/engine-client";
import type { ModelChoice } from "@/lib/models";
import { splitGenerations } from "@/lib/model-generations";
import { groupFamilies, pickInFamily, stripWindow, visibleModels } from "@/lib/model-families";
import { useModelCatalogue } from "@/lib/model-catalogue-cache";
import { selectionOf } from "../model-options";

/** The model and effort rows the `/` menu offers, from the same selection as the pills. Legacy generations are left out. */
export function useComposerCommandChoices(
  driver: ProviderDriverKind,
  choice: ModelChoice,
  instanceId?: string,
): { models: { id: string; label: string }[]; efforts: string[] } {
  const catalogue = useModelCatalogue(driver, instanceId);
  const models = catalogue?.models;
  // Depends on the fields, not the choice: the composer builds a fresh one every render.
  const { model, effort, fastMode } = choice;
  return useMemo(() => {
    if (!models) return { models: [], efforts: [] };
    const selection = selectionOf(models, {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode === undefined ? {} : { fastMode }),
    });
    return {
      models: splitGenerations(groupFamilies(visibleModels(models, model))).current.map((family) => ({
        id: pickInFamily(family, selection.window).id,
        label: stripWindow(family.label),
      })),
      efforts: [...selection.levels],
    };
  }, [models, model, effort, fastMode]);
}
