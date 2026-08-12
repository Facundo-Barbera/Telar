/**
 * WHICH MODELS ARE STILL THE POINT, AND WHICH ARE HISTORY.
 *
 * A provider's list grows and never shrinks. Codex reports seven models today
 * and every one of them is real, but three are the current generation and four
 * are older ones kept for people who pinned them — and a picker that shows all
 * seven equally makes you read four rows to find the one you want, every time,
 * forever.
 *
 * THE RULE IS "OLDER THAN THE DEFAULT", not a hand-kept list of ids. The
 * provider tells us which model is default, and a version older than that
 * default is by definition the previous generation. That survives the provider
 * shipping a new family next month, which a list of ids does not: the list would
 * need editing and, until somebody edited it, the new models would be filed as
 * legacy and the old ones as current.
 *
 * IT IS A HEURISTIC ON A STRING, and that is stated rather than hidden. Ids are
 * not a versioning scheme anybody promised us — `gpt-5.6-sol`, `claude-opus-4-8`
 * — so a model whose version cannot be read is treated as CURRENT. Being shown
 * a model you did not need is a much smaller failure than hiding one you did.
 */
import type { ProviderModel } from "@telar/engine-client";

/**
 * The version buried in a model id, as a comparable number.
 *
 *   `gpt-5.6-sol`      → 5.6
 *   `gpt-5.4-mini`     → 5.4
 *   `claude-opus-5`    → 5
 *   `claude-opus-4-8`  → 4.8   (dash-separated, which Anthropic uses)
 *   `claude-haiku-4-5` → 4.5
 *
 * Returns `undefined` when there is no number to read, which the caller treats
 * as current — see the header.
 */
export function modelVersion(id: string): number | undefined {
  // The first number in the id, optionally followed by ONE more separated by a
  // dot or a dash. A third component would be a patch level and does not change
  // which generation a model belongs to.
  const match = /(\d+)(?:[.-](\d+))?/.exec(id);
  if (!match) return undefined;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return undefined;
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return Number.isFinite(minor) ? major + minor / 100 : major;
}

export type ModelGenerations = {
  /** The default's generation and anything level with it. */
  current: ProviderModel[];
  /** Older, plus anything the provider itself marked hidden. */
  legacy: ProviderModel[];
};

export function splitGenerations(models: readonly ProviderModel[]): ModelGenerations {
  const visible = models.filter((model) => !model.hidden);
  const hidden = models.filter((model) => model.hidden);
  const defaultModel = visible.find((model) => model.isDefault) ?? visible[0];
  const line = defaultModel ? modelVersion(defaultModel.id) : undefined;

  // No readable default version: everything visible is current. A picker that
  // guessed here would be hiding models on the strength of a regex.
  if (line === undefined) return { current: visible, legacy: hidden };

  const current: ProviderModel[] = [];
  const legacy: ProviderModel[] = [...hidden];
  for (const model of visible) {
    const version = modelVersion(model.id);
    if (version === undefined || version >= line) current.push(model);
    else legacy.push(model);
  }
  return { current, legacy };
}

/** The provider's own default, which is what a new session should run. */
export function defaultModelId(models: readonly ProviderModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models.find((model) => !model.hidden))?.id;
}

/** The effort levels a specific model supports. An unknown model reports none,
 *  and the picker then offers only "Auto" — which is true rather than a guess. */
export function effortsFor(models: readonly ProviderModel[], id: string | undefined): readonly string[] {
  return models.find((model) => model.id === id)?.efforts ?? [];
}
