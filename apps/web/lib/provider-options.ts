"use client";

// WHAT A PROVIDER PUBLISHES ABOUT ITSELF — the mechanism that lets one composer
// render two harnesses without branching on either.
//
// The shape is t3code's (verified against apps/server/src/provider/Layers/
// ClaudeProvider.ts and CodexProvider.ts, 2026-08-01): a provider publishes
// GROUPS of options, each `{id, label, values: [{value, label, isDefault}]}`,
// and the surface renders whatever it finds. t3code's composer has no
// per-provider UI code at all — that is why its Claude menu can show Reasoning
// + Context Window + Fast Mode while its Codex menu shows Reasoning + Service
// Tier, through one renderer. Telar's composer used to hold a
// `provider === "codex" ? … : …` fork for exactly this, and the fork is what
// made the two surfaces drift.
//
// WE PUBLISH WHAT TELAR HONOURS. Claude's control protocol contributes the
// model-specific effort and fast-mode flags; its context aliases are projected
// as one group. Codex's cache contributes reasoning levels and service tiers.
// The adapters consume every value produced here, so adding a capability at
// the harness boundary makes it appear without adding provider branches to the
// composer itself.
//
// CLIENT-SAFE: imports only ./models (import-free data). No SDK, no node:*.

import {
  CODEX_EFFORT_OPTIONS,
  EFFORT_OPTIONS,
  type ModelInfo,
  type CodexReasoningEffort,
  type EffortLevel,
} from "./models";

export type ProviderOptionValue = {
  value: string;
  label: string;
  /** Longer text shown under the label. Optional — a group of one-word values
   *  (On/Off) reads worse with a sentence under each than without. */
  blurb?: string;
  isDefault?: boolean;
};

export type ProviderOptionGroup = {
  id: string;
  label: string;
  values: readonly ProviderOptionValue[];
};

// THE "let the model decide" VALUE, shared by both providers' effort groups.
// It is not an effort level — it means "send no effort field at all", which is
// why it cannot come from EFFORT_OPTIONS and is prepended here instead. Its id
// is the string the composer and route already agree on.
export const EFFORT_UNSET = "default";

const unsetEffort: ProviderOptionValue = {
  value: EFFORT_UNSET,
  label: "Auto",
  blurb: "Let the model choose its own effort.",
  isDefault: true,
};

const capabilityValues = (
  options: ModelInfo["reasoningOptions"],
  fallback: readonly { id: string; label: string; blurb: string }[],
): ProviderOptionValue[] =>
  (options?.length ? options : fallback).map((option) => ({
    value: option.id,
    label: option.label,
    blurb: option.blurb,
    isDefault: "isDefault" in option ? option.isDefault : undefined,
  }));

function contextValues(model: ModelInfo, models: readonly ModelInfo[]): ProviderOptionValue[] {
  const familyKey = (candidate: ModelInfo) =>
    (candidate.resolvedModel ?? candidate.id).replace(/\[1m\]$/i, "");
  const baseResolved = familyKey(model);
  const sameModel = models.filter(
    (candidate) => familyKey(candidate) === baseResolved,
  );
  const byContext = new Map(sameModel.map((candidate) => [candidate.context, candidate.id]));
  if (model.context === "1M" && /\[1m\]$/i.test(model.id) && !byContext.has("200K")) {
    byContext.set("200K", model.id.replace(/\[1m\]$/i, ""));
  }
  if (model.context === "200K" && model.resolvedModel && !byContext.has("1M")) {
    byContext.set("1M", `${model.id}[1m]`);
  }
  return ["200K", "1M"].flatMap((label) => {
    const value = byContext.get(label);
    return value ? [{ value, label, isDefault: label === "200K" }] : [];
  });
}

/** Everything this provider lets a session tune, beyond the model and the
 *  runtime mode. Ordered — the composer renders groups top to bottom and joins
 *  their active labels with "·" for the trigger, exactly as t3code does
 *  ("Medium · Standard"). */
export function providerOptionGroups(
  provider: "claude" | "codex",
  model?: ModelInfo,
  models: readonly ModelInfo[] = [],
): readonly ProviderOptionGroup[] {
  const fallback = provider === "codex" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS;
  const effortValues = capabilityValues(model?.reasoningOptions, fallback as readonly {
    id: CodexReasoningEffort | EffortLevel;
    label: string;
    blurb: string;
  }[]);
  const groups: ProviderOptionGroup[] = [{
    id: "effort",
    label: "Reasoning",
    values: model?.reasoningOptions?.length ? effortValues : [unsetEffort, ...effortValues],
  }];

  if (provider === "claude" && model) {
    const contexts = contextValues(model, models);
    if (contexts.length > 1) {
      groups.push({ id: "model", label: "Context Window", values: contexts });
    }
    if (model.supportsFastMode) {
      groups.push({
        id: "fastMode",
        label: "Fast Mode",
        values: [
          { value: "off", label: "Off", isDefault: true },
          { value: "on", label: "On" },
        ],
      });
    }
  }

  if (provider === "codex" && model?.serviceTiers?.length) {
    groups.push({
      id: "serviceTier",
      label: "Service Tier",
      values: model.serviceTiers.map((option) => ({
        value: option.id,
        label: option.label,
        blurb: option.blurb,
        isDefault: option.isDefault,
      })),
    });
  }
  return groups;
}

/** The value a group falls back to. Every group must declare exactly one
 *  default; this returns it rather than assuming index 0, so reordering a
 *  group's values can never silently change what a new session starts at. */
export function groupDefault(group: ProviderOptionGroup): string {
  return (group.values.find((v) => v.isDefault) ?? group.values[0]!).value;
}

/** Is `value` something this provider actually published? The route already
 *  400s an unknown effort; this is the same question asked client-side so the
 *  composer never offers, or restores from project memory, a value the
 *  provider would reject — e.g. Claude's "max" surviving a switch to Codex,
 *  which does not have it. */
export function groupAccepts(group: ProviderOptionGroup, value: string): boolean {
  return group.values.some((v) => v.value === value);
}

/** The label for a group's current value, for the collapsed trigger. Falls back
 *  to the raw value rather than to the default's label — showing "Auto" for a
 *  value that is not Auto would misreport the session's own config. */
export function groupValueLabel(group: ProviderOptionGroup, value: string): string {
  return group.values.find((v) => v.value === value)?.label ?? value;
}

/** The collapsed trigger mirrors T3 Code: every active value is visible, even
 *  when it is the default (for example `High · 1M` or `Medium · Standard`). */
export function triggerLabel(
  groups: readonly ProviderOptionGroup[],
  values: Readonly<Record<string, string>>,
): string | null {
  const parts = groups.map((g) => {
    const v = values[g.id] ?? groupDefault(g);
    return groupValueLabel(g, v);
  });
  return parts.length ? parts.join(" · ") : null;
}
