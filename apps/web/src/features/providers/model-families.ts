import type { ProviderModel } from "@telar/engine-client";

export type ContextWindow = "standard" | "long";

export const WINDOW_LABEL: Record<ContextWindow, string> = { standard: "200k", long: "1M" };

export function contextWindowOf(model: Pick<ProviderModel, "id" | "resolves" | "contextWindow">): ContextWindow {
  if (model.contextWindow !== undefined) return model.contextWindow >= 1_000_000 ? "long" : "standard";
  return /\[1m\]$/i.test(model.id) || /\[1m\]$/i.test(model.resolves ?? "") ? "long" : "standard";
}

export function familyKey(model: Pick<ProviderModel, "id" | "resolves">): string {
  return (model.resolves ?? model.id).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

export type ModelFamily = {
  id: string;
  label: string;
  isDefault: boolean;
  hidden: boolean;
  legacy: boolean;
  badge?: "new";
  rows: ProviderModel[];
};

export function stripWindow(label: string): string {
  return label.replace(/\s*\([^)]*\bcontext\b[^)]*\)\s*$/i, "").trim();
}

export function groupFamilies(models: readonly ProviderModel[]): ModelFamily[] {
  const families = new Map<string, ProviderModel[]>();
  for (const model of models) {
    const key = familyKey(model);
    const rows = families.get(key);
    if (rows) rows.push(model);
    else families.set(key, [model]);
  }
  return [...families].map(([id, rows]) => {
    const named = rows.find((row) => contextWindowOf(row) === "standard") ?? rows[0]!;
    return {
      id,
      label: versionedLabel(stripWindow(named.label) || named.label, id),
      isDefault: rows.some((row) => row.isDefault),
      hidden: rows.every((row) => row.hidden),
      legacy: rows.every((row) => row.legacy),
      ...(rows.some((row) => row.badge === "new") ? { badge: "new" as const } : {}),
      rows,
    };
  });
}

function versionedLabel(label: string, id: string): string {
  if (/\d/.test(label)) return label;
  const version = /-(\d+(?:-\d+)*)$/.exec(id)?.[1]?.replaceAll("-", ".");
  return version ? `${label} ${version}` : label;
}

export function rowOf(models: readonly ProviderModel[], id: string | undefined): ProviderModel | undefined {
  if (!id) return undefined;
  return models.find((model) => model.id === id) ?? models.find((model) => model.resolves === id);
}

export function familyFavorites(models: readonly ProviderModel[], starredRows: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const model of models) if (starredRows.has(model.id)) out.add(familyKey(model));
  return out;
}

export function toggleFamilyFavorite(
  models: readonly ProviderModel[],
  starredRows: readonly string[],
  familyId: string,
): string[] {
  const rows = models.filter((model) => familyKey(model) === familyId).map((model) => model.id);
  if (rows.length === 0) return [...starredRows];
  const starred = new Set(starredRows);
  const on = rows.some((id) => starred.has(id));
  for (const id of rows) {
    if (on) starred.delete(id);
    else starred.add(id);
  }
  return [...starred];
}

export function visibleModels(models: readonly ProviderModel[], keep: string | undefined): ProviderModel[] {
  return models.filter((model) => !model.hiddenByUser || (keep !== undefined && (model.id === keep || model.resolves === keep)));
}

export function familyOf(families: readonly ModelFamily[], id: string | undefined): ModelFamily | undefined {
  if (!id) return undefined;
  return families.find((family) => family.rows.some((row) => row.id === id || row.resolves === id));
}

export function windowsOf(family: ModelFamily | undefined): ContextWindow[] {
  const windows = new Set((family?.rows ?? []).map(contextWindowOf));
  return (["standard", "long"] as const).filter((option) => windows.has(option));
}

export function rowFor(family: ModelFamily | undefined, window: ContextWindow): ProviderModel | undefined {
  return family?.rows.find((row) => contextWindowOf(row) === window);
}

export function pickInFamily(family: ModelFamily, window: ContextWindow): ProviderModel {
  return rowFor(family, window) ?? family.rows.find((row) => row.isDefault) ?? rowFor(family, "standard") ?? family.rows[0]!;
}

export function windowSuffix(window: ContextWindow, windows: readonly ContextWindow[]): string | undefined {
  return windows.length > 1 ? WINDOW_LABEL[window] : undefined;
}
