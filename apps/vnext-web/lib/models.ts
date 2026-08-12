/**
 * What the composer's model picker offers, per provider.
 *
 * A STATIC CATALOGUE, AND THAT IS A GAP RATHER THAN A DESIGN. The frozen app
 * had `/api/models` behind a provider registry that could ask each installed
 * harness what it supports; the vNext engine models a session's `ModelSelection`
 * but exposes no way to enumerate valid ones. Until it does, this list is the
 * cockpit's own, and it will go stale the way any hand-maintained list does.
 *
 * TWO RULES FOR EDITING IT. Use the exact published id, with no date suffix —
 * `claude-opus-5`, never `claude-opus-5-20260101`; a constructed id 404s at the
 * provider. And keep `blurb` about the CHOICE ("the default; deepest reasoning")
 * rather than about benchmark scores, which age faster than the ids do.
 *
 * The picker also always offers PROVIDER DEFAULT — the session naming no model
 * at all, which is different from naming one that happens to match. It means
 * "run whatever the installed harness is configured for", and it is the only
 * honest option when this list has fallen behind.
 */
import type { ProviderDriverKind } from "@telar/engine-client";

export type ModelOption = {
  /** The exact string handed to the provider. */
  id: string;
  label: string;
  blurb: string;
};

export const MODELS: Record<ProviderDriverKind, ModelOption[]> = {
  claude: [
    { id: "claude-opus-5", label: "Opus 5", blurb: "The default. Deepest reasoning and long-horizon agentic work." },
    { id: "claude-sonnet-5", label: "Sonnet 5", blurb: "Near-Opus quality on coding, at Sonnet speed and cost." },
    { id: "claude-opus-4-8", label: "Opus 4.8", blurb: "The previous Opus. Pin it when a change in 5 regressed you." },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", blurb: "Fastest and cheapest. Good for short, scoped work." },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", blurb: "The Codex default." },
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex", blurb: "Tuned for code editing and review." },
  ],
};

/** Effort levels, where the provider has the concept. Absent means the model
 *  chooses — which is not the same as any level named here. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * WHICH LEVELS EACH PROVIDER IS OFFERED, and why the lists differ.
 *
 * The two drivers treat an unknown level differently, so the cost of guessing
 * wrong is not symmetric. The Claude seam validates against the Agent SDK's own
 * `EffortLevel` and DROPS anything else (apps/engine/src/driver.ts,
 * `claudeEffort`), so an over-long list there degrades to "no level". Codex
 * forwards the string verbatim to the app-server, where a word it does not know
 * fails the turn — so its list is the conservative subset.
 *
 * Hand-maintained for the same reason `MODELS` is: the engine models a
 * session's effort but cannot enumerate the valid ones.
 */
export const PROVIDER_EFFORTS: Record<ProviderDriverKind, readonly Effort[]> = {
  claude: EFFORTS,
  codex: ["low", "medium", "high"],
};

export const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORT_HELP: Record<Effort, string> = {
  low: "Minimal thinking, fastest answers.",
  medium: "Moderate thinking.",
  high: "Deep reasoning. What most models default to.",
  xhigh: "Deeper than high, on the models that have it.",
  max: "As much deliberation as the model allows.",
};

/** What the reasoning pill reads. Unset is AUTO — the provider's own default,
 *  which is a real state and not the same as any level above. An unrecognised
 *  level prints as itself, so a session never misreports what it is running. */
export function effortLabel(value: string | undefined): string {
  if (!value) return "Auto";
  return EFFORT_LABEL[value as Effort] ?? value;
}

/** The label for a model this catalogue may not know. A session can carry a
 *  model set before an entry existed, or by a client that is not this one, and
 *  showing the raw id beats showing nothing. */
export function modelLabel(driver: ProviderDriverKind, id: string | undefined): string {
  if (!id) return "Provider default";
  return MODELS[driver].find((model) => model.id === id)?.label ?? id;
}
