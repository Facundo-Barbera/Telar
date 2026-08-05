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
// WE PUBLISH WHAT TELAR HONOURS, NOT WHAT T3CODE PUBLISHES. t3code's Claude
// list carries `ultracode`, `ultrathink`, `contextWindow` and `fastMode`; its
// Codex list carries `serviceTier`. Telar's adapters wire none of those today —
// `runCodexTurn` takes no serviceTier, and the Claude branch sets no
// ultracode/fastMode settings — so listing them would offer a control that
// silently does nothing, which is the same failure as publishing a capability
// you cannot honour. When an adapter grows one, it is added HERE and the
// composer shows it with no UI change. That is the whole point of the seam.
//
// CLIENT-SAFE: imports only ./models (import-free data). No SDK, no node:*.
//
// AND DELIBERATELY NOT "use client". This module is now read from BOTH sides —
// the composer renders the groups, app/api/chat/route.ts validates an incoming
// value against the same ones — and that is the entire point: one predicate, so
// a menu cannot offer what the route then 400s. The directive would forbid
// exactly that. Next turns a direct server-layer import of a "use client"
// module into a client REFERENCE, so calling groupAccepts() from the route
// throws "Attempted to call groupAccepts() from the server but groupAccepts is
// on the client" at request time — a 500 on the live path that tsc, eslint and
// bun test all stay green through, because none of them runs the RSC transform.
// A module with no hooks and no browser API has no reason to declare a side;
// what makes it safe for the client bundle is its import graph, which the line
// above states and INV-4c enforces.

import {
  CODEX_EFFORT_OPTIONS,
  EFFORT_OPTIONS,
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

const claudeEffort: ProviderOptionGroup = {
  id: "effort",
  label: "Reasoning",
  values: [
    unsetEffort,
    ...EFFORT_OPTIONS.map((e: { id: EffortLevel; label: string; blurb: string }) => ({
      value: e.id,
      label: e.label,
      blurb: e.blurb,
    })),
  ],
};

const codexEffort: ProviderOptionGroup = {
  id: "effort",
  label: "Reasoning",
  values: [
    unsetEffort,
    ...CODEX_EFFORT_OPTIONS.map((e: { id: CodexReasoningEffort; label: string; blurb: string }) => ({
      value: e.id,
      label: e.label,
      blurb: e.blurb,
    })),
  ],
};

/** Everything this provider lets a session tune, beyond the model and the
 *  runtime mode. Ordered — the composer renders groups top to bottom and joins
 *  their active labels with "·" for the trigger, exactly as t3code does
 *  ("Medium · Standard"). */
export function providerOptionGroups(provider: "claude" | "codex"): readonly ProviderOptionGroup[] {
  // THE ONLY PROVIDER FORK LEFT IN THE OPTION PATH, and it belongs here: this
  // is the table's own dispatch, at the seam whose entire job is to hold it.
  // Pushing it anywhere else means a caller asking which harness it landed on
  // again, which is the shape this module was written to end.
  return provider === "codex" ? [codexEffort] : [claudeEffort];
}

/** One published group by id, or undefined when this provider publishes none
 *  under that name. The question a caller asks when it wants a specific knob —
 *  the chat route validating an incoming `effort`, say — rather than the whole
 *  menu. Undefined is a real answer and means "this provider does not offer
 *  this at all", which a validator must read as "reject", never as "allow". */
export function providerOptionGroup(
  provider: "claude" | "codex",
  id: string,
): ProviderOptionGroup | undefined {
  return providerOptionGroups(provider).find((g) => g.id === id);
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

/** The collapsed trigger text — active labels joined by "·", skipping any group
 *  sitting on its default so the bar stays quiet until something is actually
 *  set. Returns null when everything is default, which the caller renders as
 *  the group's own name instead of a value. */
export function triggerLabel(
  groups: readonly ProviderOptionGroup[],
  values: Readonly<Record<string, string>>,
): string | null {
  const parts = groups.flatMap((g) => {
    const v = values[g.id] ?? groupDefault(g);
    return v === groupDefault(g) ? [] : [groupValueLabel(g, v)];
  });
  return parts.length ? parts.join(" · ") : null;
}
