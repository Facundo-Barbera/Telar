/**
 * WHAT THE COMPOSER'S CONTROLS SPEAK, now that the provider answers for itself.
 *
 * THIS FILE USED TO HOLD THE CATALOGUE and it was wrong in every direction. It
 * listed `gpt-5.5-codex`, which does not exist; it listed `claude-opus-4-8`,
 * which the installed Claude Code does not offer; it omitted Fable 5 entirely;
 * and it recorded a `long` flag per model to gate a 1M context beta that is not
 * a beta any more. Every one of those was found by finally asking the two
 * providers what they have (apps/engine/src/models.ts) rather than by review.
 *
 * So the list is gone. `useModelCatalogue` reads the engine, the rows are the
 * provider's own, and what is left here is the vocabulary a control needs
 * REGARDLESS of which models exist: how to name an effort level, and how to
 * label a model the catalogue has not loaded yet.
 */
import { defaultInstanceIdForDriver, type ModelSelection, type ProviderDriverKind, type ProviderModel } from "@telar/engine-client";

/** Effort levels, where the provider has the concept. Absent means the model
 *  chooses — which is not the same as any level named here. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

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
  /** Latency over quality. Offered only on the models whose catalogue row says
   *  the provider supports it — two of Claude Code's six, and none of Codex's. */
  fastMode?: boolean;
  /** The service tier, by the provider's own id. Offered only on a model whose
   *  row lists `serviceTiers` — Codex's today. */
  serviceTier?: string;
  /** Xhigh reasoning plus workflow orchestration, on a Claude model with xhigh. */
  ultracode?: boolean;
};

/** Every field a choice carries, from anything shaped like one — a stored
 *  selection, a turn's, a project default. The one copy of the field list. */
export function choiceOf(from: ModelChoice | undefined): ModelChoice {
  return {
    ...(from?.model ? { model: from.model } : {}),
    ...(from?.effort ? { effort: from.effort } : {}),
    ...(from?.fastMode === undefined ? {} : { fastMode: from.fastMode }),
    ...(from?.serviceTier ? { serviceTier: from.serviceTier } : {}),
    ...(from?.ultracode === undefined ? {} : { ultracode: from.ultracode }),
  };
}

/** Whether a choice selects anything — an empty one is the provider default. */
export function choiceNamesAnything(choice: ModelChoice | undefined): boolean {
  return Object.keys(choiceOf(choice)).length > 0;
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
export function modelLabel(models: readonly ProviderModel[], id: string | undefined): string {
  if (!id) return models.find((model) => model.isDefault)?.label ?? "Default";
  const row = models.find((model) => model.id === id);
  if (row) return row.label;
  /**
   * A STORED WIRE ID MATCHED BACK TO ITS ALIAS. Claude Code's rows are mostly
   * aliases — `sonnet` — and each carries the canonical id it resolves to. A
   * session that stored `claude-sonnet-5` (from another client, or from before
   * the alias moved) is running exactly what `sonnet` runs, so it should read as
   * `Sonnet` rather than as an unknown id.
   */
  return models.find((model) => model.resolves === id)?.label ?? id;
}


/** Provider defaults are represented by no selection, never an instance-only object. */
export function sessionModelSelection(instanceId: string, choice: ModelChoice): ModelSelection | undefined {
  if (!choiceNamesAnything(choice)) return undefined;
  return { instanceId, ...choiceOf(choice) } as ModelSelection;
}

/**
 * WHERE A NEW CONVERSATION'S COMPOSER STARTS: the project's default model and
 * options, so the composer shows what the first message will actually run on and
 * a change to one knob keeps the rest.
 *
 * ONLY A DEFAULT STORED AGAINST A PROVIDER'S BUILT-IN LOGIN. The canvas creates a
 * session by driver, which lands on that login, and the engine applies a
 * project's default only to a session on the login it names — so a default for
 * another login would never run from here, and showing it would be a lie.
 */
export function projectDraftModel(selection: ModelSelection | undefined): { driver: ProviderDriverKind; choice: ModelChoice } | undefined {
  if (!selection) return undefined;
  const driver = (["claude", "codex", "opencode"] as const).find((option) => defaultInstanceIdForDriver(option) === selection.instanceId);
  if (!driver) return undefined;
  return {
    driver,
    choice: choiceOf(selection),
  };
}
