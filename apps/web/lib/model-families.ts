/**
 * ONE ROW PER MODEL, NOT ONE ROW PER CONTEXT WINDOW.
 *
 * The installed Claude Code answers with five rows for four models: `sonnet` and
 * `sonnet[1m]` are the same Sonnet with a different window, and `opus[1m]` is
 * the only Opus there is. Listed flat, that picker asks two questions in one
 * place — WHICH MODEL and HOW MUCH CONTEXT — and answers neither: half the rows
 * are the same name twice, and the window ends up written into the model's own
 * label ("Opus (1M context)"), where it is a fact you can read and not a control
 * you can reach.
 *
 * SO THE PICKER LISTS FAMILIES AND THE WINDOW BECOMES A SETTING, sitting with
 * the reasoning level where the other per-turn knobs are. That is where the
 * reference cockpit puts it — its pill reads `Extra High · 1M` — and where the
 * donor put it too, as a `Standard | 1M` group inside the reasoning popover.
 *
 * IT IS STILL THE PROVIDER'S OWN MODEL ID ON THE WIRE. A family is a way of
 * READING the catalogue, not a thing the contract knows about: choosing Sonnet
 * with a 1M window sends `sonnet[1m]`, the same string that picking that row
 * sent before. `ModelSelection` is unchanged, the engine is unchanged, and a
 * provider that stops publishing a long variant simply stops offering the
 * control — which is the property the deleted `default | 1m` switch never had.
 *
 * THE FOLD IS THE DONOR'S RULE (`modelFamilyKey` in the frozen cockpit): strip
 * the `[1m]` suffix and a trailing dated build from the id the alias RESOLVES
 * to. Resolved rather than literal, because Claude Code's rows are mostly
 * aliases — `sonnet` resolves to `claude-sonnet-5` and `sonnet[1m]` to
 * `claude-sonnet-5[1m]`, which are obviously one family; their literal ids are
 * not obviously anything.
 */
import type { ProviderModel } from "@telar/engine-client";

export type ContextWindow = "standard" | "long";

/**
 * What the pill and the menu call each window. THE NUMBER, NOT THE WORD:
 * this read `Standard | 1M` and a person on Fable 5.1 — whose pill showed bare
 * `High` — could not tell they were on 200k and thought they were already on
 * 1M. Measured on the dogfood app. T3 Code prints `200k | 1M` for the same
 * reason.
 */
export const WINDOW_LABEL: Record<ContextWindow, string> = { standard: "200k", long: "1M" };

/**
 * `[1m]`, AND NOTHING ELSE COUNTS.
 *
 * This is Claude Code's own spelling and the only long-window marker either
 * provider publishes today. A model that never says `[1m]` is reported as
 * standard rather than unknown, because "standard" is what every id without the
 * suffix means — including every Codex id, none of which have windows to pick.
 */
export function contextWindowOf(model: Pick<ProviderModel, "id" | "resolves">): ContextWindow {
  return /\[1m\]$/i.test(model.id) || /\[1m\]$/i.test(model.resolves ?? "") ? "long" : "standard";
}

/**
 * The id two rows share when they are the same model.
 *
 *   `sonnet`            → resolves `claude-sonnet-5`               → `claude-sonnet-5`
 *   `sonnet[1m]`        → resolves `claude-sonnet-5[1m]`           → `claude-sonnet-5`
 *   `haiku`             → resolves `claude-haiku-4-5-20251001`     → `claude-haiku-4-5`
 *   `gpt-5.6-sol`       → no alias                                 → `gpt-5.6-sol`
 *
 * THE DATED SUFFIX GOES TOO, for the same reason as the window: two builds of
 * one model dated a month apart are one row to a reader, and the provider is the
 * one deciding which build the alias points at today.
 */
export function familyKey(model: Pick<ProviderModel, "id" | "resolves">): string {
  return (model.resolves ?? model.id).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

/**
 * A model as the picker lists it: the name, and every window it comes in.
 *
 * SHAPED LIKE A `ProviderModel` ON PURPOSE — `id`, `isDefault`, `hidden` — so
 * the two helpers that already sort and split a catalogue (`orderByFavorite`,
 * `splitGenerations`) work on families without learning a second shape. `id`
 * here is the FAMILY key, which is also what a star is stored against.
 */
export type ModelFamily = {
  id: string;
  label: string;
  isDefault: boolean;
  hidden: boolean;
  /** The manifest filed every row of it as history — see `splitGenerations`. */
  legacy: boolean;
  /** The manifest's mark for it, `new` on a model that just shipped. */
  badge?: "new";
  /** The provider's own rows, in catalogue order. Never empty. */
  rows: ProviderModel[];
};

/**
 * The window out of a model's name.
 *
 * "Opus (1M context)" is the provider describing a row that is about to stop
 * being a row. Once the window is a control, that parenthetical is the label
 * repeating a setting the reader can already see — and worse, disagreeing with
 * it the moment they switch.
 */
export function stripWindow(label: string): string {
  return label.replace(/\s*\([^)]*\bcontext\b[^)]*\)\s*$/i, "").trim();
}

/**
 * Fold a catalogue into families, in catalogue order.
 *
 * THE NAME COMES FROM THE STANDARD ROW WHERE THERE IS ONE, because that is the
 * label the provider wrote without a window in mind — Sonnet's pair is "Sonnet"
 * and "Sonnet 5 (1M context)", and the first is the better name for both. Where
 * there is no standard row (Opus, today) the long row's label is used with its
 * window stripped.
 *
 * HIDDEN ONLY IF EVERY VARIANT IS HIDDEN. `hidden` is the provider saying "do
 * not show this at all", and it says it per row; one visible window is enough to
 * make the model worth listing.
 */
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

/**
 * The version, restored to a label the provider published without one.
 *
 * Claude Code's `displayName`s are bare — "Opus", "Sonnet", "Haiku" — while
 * the version lives in the wire id this family is already keyed by
 * (`claude-sonnet-5`, `claude-haiku-4-5`). A picker listing three bare names
 * across generations cannot say WHICH Sonnet you are choosing, so the trailing
 * numeric run of the family key is appended, dashes read as dots.
 *
 * ONLY when the label carries no digit of its own: Codex's "GPT-5.6-Sol"
 * already says its version, and doubling it would be the stutter this module
 * exists to remove. And ONLY from the id — no version is ever invented for a
 * family whose key ends in prose.
 *
 * NOT `modelVersion` (model-generations.ts): that is an ORDERING key —
 * `claude-haiku-4-5` → 4.05 — correct for sorting and wrong as a string.
 */
function versionedLabel(label: string, id: string): string {
  if (/\d/.test(label)) return label;
  const version = /-(\d+(?:-\d+)*)$/.exec(id)?.[1]?.replaceAll("-", ".");
  return version ? `${label} ${version}` : label;
}

/**
 * The catalogue row a stored id names.
 *
 * MATCHED ON THE ID FIRST AND ON `resolves` SECOND, because a session can carry
 * either: this cockpit stores the alias (`sonnet`) and another client — or an
 * older record — may have stored the wire id (`claude-sonnet-5`). Both name the
 * same row, and the row is where the efforts, the fast-mode flag and the window
 * are written, so failing to find it silently offers a model none of its own
 * settings.
 */
export function rowOf(models: readonly ProviderModel[], id: string | undefined): ProviderModel | undefined {
  if (!id) return undefined;
  return models.find((model) => model.id === id) ?? models.find((model) => model.resolves === id);
}

/**
 * WHICH FAMILIES COUNT AS STARRED, given the rows that are.
 *
 * THE STORE IS ROW-KEYED AND THE PICKER IS FAMILY-KEYED, so one of them has to
 * derive. Rows win as the stored form: `sonnet` and `sonnet[1m]` are two ids the
 * Models tab lists separately, and a family key moves when the provider re-points
 * an alias. So a family is starred when ANY of its rows is — which is also the
 * rule that makes the derived bit survive switching context window, the thing the
 * old family-keyed store got for free.
 */
export function familyFavorites(models: readonly ProviderModel[], starredRows: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const model of models) if (starredRows.has(model.id)) out.add(familyKey(model));
  return out;
}

/**
 * Star or unstar a whole family, as a new list of ROW ids.
 *
 * WRITES EVERY ROW, so the derived bit above is never ambiguous: a family with
 * one row starred and one not would read as starred and un-star in one press,
 * which is a control that does something different from what it says.
 */
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

/**
 * The rows a MENU should list — everything except what the reader curated away,
 * AND whatever is running right now.
 *
 * THE EXCEPTION IS THE WHOLE POINT. Hiding a model must not make the session
 * already on it read as running something else; that is the failure the
 * "external" row in the composer exists to prevent for a model the catalogue
 * never had, and a model the reader hid is the same problem arriving from the
 * opposite direction. So a hidden row stays listed, ticked, for exactly as long
 * as it is the choice — and the hide takes effect the moment you move off it.
 *
 * MATCHED ON `id` THEN `resolves`, like `rowOf`, so a session carrying the wire
 * id of an alias keeps its own row visible too.
 *
 * Note this filters ROWS, before `groupFamilies`. That is what makes every
 * family-level consequence fall out for free: a family whose rows are all hidden
 * simply never gets built, and hiding only `sonnet[1m]` leaves Sonnet listed
 * with one window instead of two.
 */
export function visibleModels(models: readonly ProviderModel[], keep: string | undefined): ProviderModel[] {
  return models.filter((model) => !model.hiddenByUser || (keep !== undefined && (model.id === keep || model.resolves === keep)));
}

/** The family a concrete model id belongs to, matched the same way. Undefined
 *  for a model this catalogue does not have. */
export function familyOf(families: readonly ModelFamily[], id: string | undefined): ModelFamily | undefined {
  if (!id) return undefined;
  return families.find((family) => family.rows.some((row) => row.id === id || row.resolves === id));
}

/** The windows this model actually comes in, standard first. One entry is the
 *  common case and means there is nothing to choose. */
export function windowsOf(family: ModelFamily | undefined): ContextWindow[] {
  const windows = new Set((family?.rows ?? []).map(contextWindowOf));
  return (["standard", "long"] as const).filter((option) => windows.has(option));
}

export function rowFor(family: ModelFamily | undefined, window: ContextWindow): ProviderModel | undefined {
  return family?.rows.find((row) => contextWindowOf(row) === window);
}

/**
 * Which row runs when you pick this model — THE WINDOW YOU ARE ON, if it has
 * one.
 *
 * Because the window is now a control you set, switching model must not quietly
 * unset it: someone who chose 1M on Opus and then switched to Sonnet asked for
 * Sonnet, not for a shorter context. Where the family has no such variant the
 * provider's default row wins, then the standard one — and the pill says which,
 * so a window that could not be carried is visible rather than assumed.
 */
export function pickInFamily(family: ModelFamily, window: ContextWindow): ProviderModel {
  return rowFor(family, window) ?? family.rows.find((row) => row.isDefault) ?? rowFor(family, "standard") ?? family.rows[0]!;
}

/**
 * What the reasoning pill adds after the effort — `High · 200k`, `High · 1M`.
 *
 * SHOWN WHENEVER THERE IS A CHOICE. This used to print nothing for the
 * standard window, on the theory that "Standard" on every pill tells nobody
 * anything. It told somebody something the day it was absent: on a model with
 * a 1M variant, bare `High` gave no sign the session was on 200k, and the
 * reader assumed 1M. A window is only worth naming where it can be changed, so
 * a single-window model (Haiku, Codex) still shows nothing — absence there
 * means "no choice", the same way it does for fast mode.
 */
export function windowSuffix(window: ContextWindow, windows: readonly ContextWindow[]): string | undefined {
  return windows.length > 1 ? WINDOW_LABEL[window] : undefined;
}
