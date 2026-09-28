import type { ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import {
  effortLabel,
  type ModelChoice,
  defaultModelId,
  contextWindowOf,
  familyOf,
  groupFamilies,
  rowFor,
  rowOf,
  windowsOf,
  WINDOW_LABEL,
  type ContextWindow,
} from "@/features/providers";

export const PROVIDERS: ProviderDriverKind[] = ["claude", "codex", "opencode"];

/** The model pill, the options popover and the overflow menu all read this, so they agree. */
export function selectionOf(models: readonly ProviderModel[], choice: ModelChoice) {
  const families = groupFamilies(models);
  // No model still selects a row: the provider's default is what will run.
  const id = choice.model ?? defaultModelId(models);
  const row = rowOf(models, id);
  const family = familyOf(families, id);
  return {
    families,
    id,
    row,
    family,
    window: (row ? contextWindowOf(row) : "standard") as ContextWindow,
    windows: windowsOf(family),
    levels: row?.efforts ?? [],
    /** Absent means the provider did not say; never a guess. */
    defaultEffort: row?.defaultEffort,
    fastMode: row?.fastMode === true,
  };
}

export function reasoningPillLabel(
  effort: string | undefined,
  defaultEffort: string | undefined,
  suffix?: string,
  ultracode?: boolean,
): { label: string; isDefault: boolean } {
  const level = ultracode ? "Ultracode" : effort ? effortLabel(effort) : defaultEffort ? effortLabel(defaultEffort) : "Auto";
  return { label: suffix ? `${level} · ${suffix}` : level, isDefault: !effort && !ultracode };
}

// A keyword Claude Code reads in the message itself; there is no setting behind it.
const ULTRATHINK = "ultrathink";

export function hasUltrathink(draft: string): boolean {
  return /\bultrathink\b/i.test(draft);
}

export function toggleUltrathink(draft: string): string {
  if (hasUltrathink(draft)) return draft.replace(/\s*\bultrathink\b\s*/gi, " ").trim();
  return draft.trim() ? `${draft.trimEnd()} ${ULTRATHINK}` : ULTRATHINK;
}

/** `apply` returns the whole next choice; an `ultrathink` row edits the draft instead. */
export type ModelOptionRow = {
  key: string;
  label: string;
  description?: string;
  isDefault: boolean;
  selected: boolean;
  disabled?: boolean;
  apply?: (choice: ModelChoice) => ModelChoice;
  ultrathink?: true;
};

export type ModelOptionSection = { id: "reasoning" | "window" | "fast" | "tier"; title: string; rows: ModelOptionRow[] };

const ULTRACODE_DESCRIPTION = "Extra-high reasoning that can also plan and run multi-step workflows on its own.";
const ULTRATHINK_DESCRIPTION = "Adds the word ultrathink to your message, asking for deeper reasoning on this one turn.";

/** Picking a provider default clears the pick, so the session keeps following the provider if that default moves. */
export function modelOptionSections(
  driver: ProviderDriverKind,
  models: readonly ProviderModel[],
  choice: ModelChoice,
  options: { ultrathink?: { active: boolean } } = {},
): ModelOptionSection[] {
  const { family, row, levels, defaultEffort, fastMode, window: activeWindow, windows } = selectionOf(models, choice);
  const sections: ModelOptionSection[] = [];
  const clearReasoning = { effort: undefined, ultracode: undefined };

  const reasoning: ModelOptionRow[] = [];
  if (!defaultEffort && (levels.length > 0 || choice.effort)) {
    reasoning.push({ key: "auto", label: "Auto", isDefault: true, selected: !choice.effort && !choice.ultracode, apply: (from) => ({ ...from, ...clearReasoning }) });
  }
  for (const level of levels) {
    const isDefault = level === defaultEffort;
    reasoning.push({
      key: `effort:${level}`,
      label: effortLabel(level),
      isDefault,
      selected: !choice.ultracode && (choice.effort === level || (!choice.effort && isDefault)),
      apply: (from) => ({ ...from, ...clearReasoning, ...(isDefault ? {} : { effort: level }) }),
    });
  }
  if (choice.effort && !levels.includes(choice.effort)) {
    reasoning.push({ key: `effort:${choice.effort}`, label: choice.effort, description: "Set elsewhere", isDefault: false, selected: true, disabled: true });
  }
  if (driver === "claude" && levels.includes("xhigh")) {
    reasoning.push({
      key: "ultracode",
      label: "Ultracode",
      description: ULTRACODE_DESCRIPTION,
      isDefault: false,
      selected: choice.ultracode === true,
      apply: (from) => ({ ...from, effort: undefined, ultracode: true }),
    });
  }
  if (driver === "claude" && levels.length > 0 && options.ultrathink) {
    reasoning.push({ key: "ultrathink", label: "Ultrathink", description: ULTRATHINK_DESCRIPTION, isDefault: false, selected: options.ultrathink.active, ultrathink: true });
  }
  if (reasoning.length > 0) sections.push({ id: "reasoning", title: "Reasoning", rows: reasoning });

  if (windows.length > 1 && family) {
    sections.push({
      id: "window",
      title: "Context window",
      rows: windows.map((option) => {
        const target = rowFor(family, option);
        return {
          key: `window:${option}`,
          label: WINDOW_LABEL[option],
          isDefault: target?.defaultWindow === true,
          selected: activeWindow === option,
          disabled: !target,
          ...(target ? { apply: (from: ModelChoice) => withModel(from, target) } : {}),
        };
      }),
    });
  }

  if (fastMode) {
    sections.push({
      id: "fast",
      title: "Fast mode",
      rows: [
        { key: "fast:on", label: "On", isDefault: false, selected: choice.fastMode === true, apply: (from) => ({ ...from, fastMode: true }) },
        { key: "fast:off", label: "Off", isDefault: true, selected: choice.fastMode !== true, apply: (from) => ({ ...from, fastMode: undefined }) },
      ],
    });
  }

  const tiers = row?.serviceTiers ?? [];
  if (tiers.length > 0) {
    const defaultTier = row?.defaultServiceTier;
    const rows: ModelOptionRow[] = [];
    if (!defaultTier || !tiers.some((tier) => tier.id === defaultTier)) {
      rows.push({ key: "tier:standard", label: "Standard", isDefault: true, selected: !choice.serviceTier, apply: (from) => ({ ...from, serviceTier: undefined }) });
    }
    for (const tier of tiers) {
      const isDefault = tier.id === defaultTier;
      rows.push({
        key: `tier:${tier.id}`,
        label: tier.name,
        ...(tier.description ? { description: tier.description } : {}),
        isDefault,
        selected: choice.serviceTier === tier.id || (!choice.serviceTier && isDefault),
        apply: (from) => ({ ...from, serviceTier: isDefault ? undefined : tier.id }),
      });
    }
    sections.push({ id: "tier", title: "Service tier", rows });
  }
  return sections;
}

/** What a project's default can set for the model a choice resolves to. */
export function modelOptionsOf(
  models: readonly ProviderModel[],
  choice: ModelChoice,
  driver: ProviderDriverKind = "claude",
): { efforts: readonly string[]; fastMode: boolean; serviceTiers: readonly { id: string; name: string }[]; ultracode: boolean } {
  const { row, levels, fastMode } = selectionOf(models, choice);
  return { efforts: levels, fastMode, serviceTiers: row?.serviceTiers ?? [], ultracode: driver === "claude" && levels.includes("xhigh") };
}

/** Drops an effort or fast mode the new row does not offer, except on a hand-added row whose offer is a guess. */
export function withModel(choice: ModelChoice, row: ProviderModel): ModelChoice {
  const trusted = row.source !== "user";
  return {
    ...choice,
    model: row.id,
    ...(trusted && choice.effort && !row.efforts.includes(choice.effort) ? { effort: undefined } : {}),
    ...(trusted && choice.fastMode && !row.fastMode ? { fastMode: undefined } : {}),
  };
}

/** The catalogues a live model search reads: every provider while it can still be switched, else the session's own. */
export function searchScope(driver: ProviderDriverKind, canSwitchProvider: boolean): ProviderDriverKind[] {
  return canSwitchProvider ? [driver, ...PROVIDERS.filter((option) => option !== driver)] : [driver];
}
