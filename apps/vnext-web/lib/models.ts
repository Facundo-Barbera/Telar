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
import type { ContextWindow, ProviderDriverKind } from "@telar/engine-client";

export type ModelOption = {
  /** The exact string handed to the provider. */
  id: string;
  label: string;
  blurb: string;
  /**
   * Whether this model can run with the 1M context window.
   *
   * HAND-MAINTAINED, like the rest of this catalogue, and load-bearing: the 1M
   * window is an opt-in BETA on the Agent SDK, so offering it on a model that
   * does not support it is asking the provider for something it will refuse.
   * The picker only shows the choice where it applies.
   */
  long?: boolean;
};

export const MODELS: Record<ProviderDriverKind, ModelOption[]> = {
  claude: [
    { id: "claude-opus-5", label: "Opus 5", blurb: "The default. Deepest reasoning and long-horizon agentic work.", long: true },
    { id: "claude-sonnet-5", label: "Sonnet 5", blurb: "Near-Opus quality on coding, at Sonnet speed and cost.", long: true },
    { id: "claude-opus-4-8", label: "Opus 4.8", blurb: "The previous Opus. Pin it when a change in 5 regressed you.", long: true },
    // 200K only, which is why the context-window choice disappears on it.
    { id: "claude-haiku-4-5", label: "Haiku 4.5", blurb: "Fastest and cheapest. Good for short, scoped work." },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", blurb: "The Codex default." },
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex", blurb: "Tuned for code editing and review." },
  ],
};

/**
 * WHAT RUNS WHEN NOBODY CHOSE, named rather than left as an absence.
 *
 * The picker used to offer a "Provider default" row — a real state in the
 * contract (the session stores no model and the harness uses whatever it is
 * configured with) and a bad row in a menu. It asked the reader to hold two
 * ideas at once: which model is running, and whether anyone had said so. The
 * answer to the first is the only one anybody wants.
 *
 * So the cockpit picks a model up front and the row disappears. This is still a
 * GUESS about a harness the engine cannot interrogate — the Agent SDK exposes
 * `supportedModels()` only on a live query, which is far too much machinery for
 * a menu — and it is marked `Default` in the list so the guess is visible.
 */
export const DEFAULT_MODEL: Record<ProviderDriverKind, string> = {
  claude: "claude-opus-5",
  codex: "gpt-5.5",
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

/**
 * NO LONGER SHOWN IN THE REASONING MENU, and kept anyway.
 *
 * The menu went to one line per level because seven two-line rows turned a short
 * list into a half-screen panel — the reference cockpit lists these as bare
 * labels for the same reason. These sentences are still the right words for a
 * surface that has room to explain (a settings page, a tooltip), and rewriting
 * them from memory later would be worse than leaving them here.
 */
export const EFFORT_HELP: Record<Effort, string> = {
  low: "Minimal thinking, fastest answers.",
  medium: "Moderate thinking.",
  high: "Deep reasoning. What most models default to.",
  xhigh: "Deeper than high, on the models that have it.",
  max: "As much deliberation as the model allows.",
};

/**
 * EVERY PROVIDER KNOB THE COMPOSER CAN SET, as one value.
 *
 * Passed and returned WHOLE rather than field by field, and that is a bug fix
 * rather than tidiness: each control used to re-send only the fields it knew
 * about, so choosing an effort silently cleared the model and choosing a model
 * silently cleared the effort. A control now spreads the current choice and
 * overrides its own field, which makes that class of loss unrepresentable.
 */
export type ModelChoice = {
  model?: string;
  /**
   * AN OPEN STRING, matching the contract rather than the static list below.
   *
   * Narrowing this to the five levels this file knows was a mistake the
   * provider disproved immediately: Codex reports `ultra` on its newest model,
   * which the union would have rejected at the type level and the picker would
   * have refused to offer. `Effort` is open in the contract for exactly this
   * reason and the UI has no business being stricter than the wire.
   */
  effort?: string;
  contextWindow?: ContextWindow;
  fastMode?: boolean;
};

/** The two positions of the context switch, and what to call them. `default` is
 *  the absence of a choice, so it is never sent. */
export const CONTEXT_WINDOWS: { id: ContextWindow; label: string; blurb: string }[] = [
  { id: "default", label: "Standard", blurb: "Whatever the model ships with — 200K on most." },
  { id: "1m", label: "1M", blurb: "The long-context beta, on models that support it." },
];

/** Whether the chosen model can take the 1M window. An unnamed model is the
 *  provider default and could be anything, so the choice is offered rather than
 *  hidden — with the caveat written on the row. */
export function supportsLongContext(driver: ProviderDriverKind, id: string | undefined): boolean {
  if (driver !== "claude") return false;
  if (!id) return true;
  return MODELS.claude.some((model) => model.id === id && model.long === true);
}

/** What the reasoning pill reads. Unset is AUTO — the provider's own default,
 *  which is a real state and not the same as any level above. An unrecognised
 *  level prints as itself, so a session never misreports what it is running. */
export function effortLabel(value: string | undefined): string {
  if (!value) return "Auto";
  const known = EFFORT_LABEL[value as Effort];
  if (known) return known;
  // A level this cockpit has never heard of — Codex reports `ultra` on its
  // newest model. Title-cased so it sits in the list like the others rather
  // than announcing itself as the one nobody wrote a label for; the WORD is
  // still the provider's own, which is what matters.
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The label for a model this catalogue may not know. A session can carry a model
 * set before an entry existed, or by a client that is not this one, and showing
 * the raw id beats showing nothing.
 *
 * An ABSENT model reads as the default's label rather than as "Provider
 * default", because that is what will actually run — and because every session
 * this cockpit creates now names one explicitly, so absence is a legacy record
 * rather than a state anyone can still reach.
 */
export function modelLabel(driver: ProviderDriverKind, id: string | undefined): string {
  const resolved = id ?? DEFAULT_MODEL[driver];
  return MODELS[driver].find((model) => model.id === resolved)?.label ?? resolved;
}
