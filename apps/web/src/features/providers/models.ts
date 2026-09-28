import { defaultInstanceIdForDriver, type ModelSelection, type ProviderDriverKind, type ProviderModel } from "@telar/engine-client";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export type ModelChoice = {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  serviceTier?: string;
  ultracode?: boolean;
};

export function choiceOf(from: ModelChoice | undefined): ModelChoice {
  return {
    ...(from?.model ? { model: from.model } : {}),
    ...(from?.effort ? { effort: from.effort } : {}),
    ...(from?.fastMode === undefined ? {} : { fastMode: from.fastMode }),
    ...(from?.serviceTier ? { serviceTier: from.serviceTier } : {}),
    ...(from?.ultracode === undefined ? {} : { ultracode: from.ultracode }),
  };
}

export function choiceNamesAnything(choice: ModelChoice | undefined): boolean {
  return Object.keys(choiceOf(choice)).length > 0;
}

export function effortLabel(value: string | undefined): string {
  if (!value) return "Auto";
  const known = EFFORT_LABEL[value as Effort];
  if (known) return known;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function modelLabel(models: readonly ProviderModel[], id: string | undefined): string {
  if (!id) return models.find((model) => model.isDefault)?.label ?? "Default";
  const row = models.find((model) => model.id === id);
  if (row) return row.label;
  return models.find((model) => model.resolves === id)?.label ?? id;
}

export function sessionModelSelection(instanceId: string, choice: ModelChoice): ModelSelection | undefined {
  if (!choiceNamesAnything(choice)) return undefined;
  return { instanceId, ...choiceOf(choice) } as ModelSelection;
}

export function projectDraftModel(selection: ModelSelection | undefined): { driver: ProviderDriverKind; choice: ModelChoice } | undefined {
  if (!selection) return undefined;
  const driver = (["claude", "codex", "opencode"] as const).find((option) => defaultInstanceIdForDriver(option) === selection.instanceId);
  if (!driver) return undefined;
  return {
    driver,
    choice: choiceOf(selection),
  };
}
