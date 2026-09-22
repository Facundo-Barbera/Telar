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

export type ModelGenerations<T> = {
  /** The default's generation and anything level with it. */
  current: T[];
  /** Older, plus anything the provider itself marked hidden. */
  legacy: T[];
};

/**
 * GENERIC OVER THE ROW, because the picker no longer splits raw catalogue rows —
 * it splits FAMILIES (lib/model-families.ts), whose id is the resolved id with
 * the window and the dated build taken off.
 *
 * That is a better string to read a version out of than the one this ran on
 * before, and it fixed a real misfiling: `modelVersion("sonnet[1m]")` finds the
 * `1` in `[1m]` and reports version 1, which put the long-context Sonnet under
 * "Legacy models" next to nothing else. Its family id is `claude-sonnet-5`,
 * which reports 5, which is what it is.
 */
type Generational = { id: string; isDefault: boolean; hidden: boolean; legacy?: boolean };

export function splitGenerations<T extends Generational>(models: readonly T[]): ModelGenerations<T> {
  const visible = models.filter((model) => !model.hidden);
  const hidden = models.filter((model) => model.hidden);

  /**
   * A STATED `legacy` BEATS THE HEURISTIC BELOW. Claude's rows carry it from
   * the model manifest (T3 Code's list), which knows that Sonnet 5 is current
   * beside Opus 5.5 — something no version rule can read off the ids. The
   * heuristic stays for a driver whose rows state nothing (Codex).
   */
  if (models.some((model) => model.legacy)) {
    return { current: visible.filter((model) => !model.legacy), legacy: [...hidden, ...visible.filter((model) => model.legacy)] };
  }
  const defaultModel = visible.find((model) => model.isDefault);
  const line = defaultModel ? modelVersion(defaultModel.id) : undefined;

  // No stated default, or one whose version cannot be read: everything visible
  // is current. Both used to guess — `?? visible[0]` anchored the split on
  // whatever happened to be listed first, which for a provider that marks no
  // default (OpenCode's 200-row multi-connection list) made the filing depend
  // on catalogue order. A picker that guesses here is hiding models on the
  // strength of a regex.
  if (line === undefined) return { current: visible, legacy: hidden };

  /**
   * CURRENT REACHES ONE GENERATION BACK, not only the default's line.
   *
   * The day Codex shipped GPT-6-Astra as its default, the whole actively-used
   * 5.6 family — three models people had sessions on that morning — fell under
   * "Legacy models" behind a fold, because the rule was "older than the
   * default". A new default arriving does not make last month's models
   * history; it makes them the PREVIOUS generation, which readers still reach
   * for daily. So the newest version line strictly below the default's stays
   * current too, and only what is older than THAT folds away.
   */
  const versions = visible.map((model) => modelVersion(model.id)).filter((version): version is number => version !== undefined);
  const previousLine = Math.max(...versions.filter((version) => version < line), Number.NEGATIVE_INFINITY);

  const current: T[] = [];
  const legacy: T[] = [...hidden];
  for (const model of visible) {
    const version = modelVersion(model.id);
    if (version === undefined || version >= (previousLine === Number.NEGATIVE_INFINITY ? line : previousLine)) current.push(model);
    else legacy.push(model);
  }
  return { current, legacy };
}

/** The provider's own default, which is what a new session should run. */
export function defaultModelId(models: readonly ProviderModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models.find((model) => !model.hidden))?.id;
}

/**
 * THERE IS NO `effortsFor` HERE ANY MORE. It matched a model by `id` alone,
 * which silently reported "no effort levels" for a session carrying the wire id
 * of an alias — every menu then offered only Auto for a model with five levels.
 * The menus read `rowOf(models, id)?.efforts` instead (lib/model-families.ts),
 * which matches an alias to what it resolves to.
 */
