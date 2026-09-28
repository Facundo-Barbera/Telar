import type { CustomProviderModel, ModelOverlay, ProviderModel } from "@telar/engine-client";
import { claudeSlugOf } from "./manifest";

type ListOverlay = Pick<ModelOverlay, "hidden" | "order" | "custom" | "default">;

export function chosenDefault(models: readonly ProviderModel[], chosen: string | undefined): ProviderModel | undefined {
  if (!chosen) return undefined;
  return models.find((model) => model.id === chosen && !model.hidden && model.source !== "user");
}

function canonical(id: string): string {
  return claudeSlugOf(id) ?? id.replace(/\[1m\]$/i, "");
}

function published(models: readonly ProviderModel[], id: string): boolean {
  const requested = canonical(id);
  return models.some((model) => {
    const modelId = canonical(model.id);
    const resolves = model.resolves ? canonical(model.resolves) : undefined;
    return modelId === requested || resolves === requested;
  });
}

function customRow(entry: CustomProviderModel, models: readonly ProviderModel[]): ProviderModel {
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    isDefault: false,
    hidden: false,
    hiddenByUser: false,
    legacy: false,
    efforts: [...new Set(models.flatMap((model) => model.efforts))],
    fastMode: false,
    source: "user",
  };
}

export function applyModelOverlay(models: readonly ProviderModel[], overlay: ListOverlay): ProviderModel[] {
  const hidden = new Set(overlay.hidden);
  const chosen = chosenDefault(models, overlay.default);
  const marked: ProviderModel[] = models.map((model) => ({
    ...model,
    hiddenByUser: hidden.has(model.id),
    ...(chosen ? { isDefault: model.id === chosen.id } : {}),
  }));

  for (const entry of overlay.custom) {
    if (published(models, entry.id)) continue;
    marked.push({ ...customRow(entry, models), hiddenByUser: hidden.has(entry.id) });
  }

  const ranked: ProviderModel[] = [];
  const placed = new Set<string>();
  for (const id of overlay.order) {
    const row = marked.find((model) => model.id === id);
    if (row && !placed.has(row.id)) {
      ranked.push(row);
      placed.add(row.id);
    }
  }
  for (const row of marked) if (!placed.has(row.id)) ranked.push(row);
  return ranked;
}
