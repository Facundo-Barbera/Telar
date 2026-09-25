/**
 * THE MODEL MANIFEST — Telar's Claude model list, which is T3 Code's, copied.
 *
 * The list is the owner's decision: T3 Code's `model-manifest.json`
 * (pingdotgg/t3code at f25a8e4b), verbatim in ids, names, aliases, status and
 * windows. It replaced two guesses that were visibly wrong in the cockpit:
 * Sonnet 5 filed under "Legacy models" because the picker inferred generations
 * from version numbers, and Fable 5 dropped outright when Fable 5.1 arrived.
 * The manifest STATES which models are current and which are legacy; nothing
 * here infers it.
 *
 * WHAT `applyModelManifest` DOES:
 *
 *  1. EVERY MANIFEST MODEL IS A ROW, listed by the CLI or not. Measured on this
 *     app: the same Claude Code binary listed `claude-fable-5-1` in the morning
 *     and not in the afternoon — the list is served from an entitlement
 *     lookup — while a session on it kept running. A row the CLI does list, for
 *     the same canonical id, wins its label, description, efforts and
 *     `resolves`; the manifest supplies only what the CLI omits.
 *
 *  2. `legacy` and `badge` come from the manifest's `status` and `badge`.
 *
 *  3. WINDOWS. A profile with a choice of window gets a `[1m]` row (the CLI's,
 *     or synthesized), and `defaultWindow` marks the row of its default window.
 *     Only the DEFAULT window's rows are published besides `[1m]`: Fable and
 *     Opus default to 1M, so they publish only `[1m]` (the earlier decision
 *     stands); Sonnet defaults to 200k, so it publishes both.
 *
 *  4. `isDefault` is the manifest's `defaults.chat` on its default window,
 *     over whatever the CLI calls default.
 *
 *  5. `minVersion`: a model the installed Claude Code is too old for is
 *     `hidden`, the provider's own "do not offer this" — but only when the
 *     version is known.
 *
 * An EMPTY list passes through empty: it means the CLI could not be asked, and
 * its own error is a better answer than eleven rows it may not run.
 *
 * BUNDLED, NO NETWORK. Updating the list is shipping a build. A remote refresh
 * (T3 Code's shape: fetch the same file from a public URL, bundled copy as
 * fallback) is a follow-up on top of this, not a prerequisite.
 */
import type { Effort, ProviderModel } from "@telar/engine-client";
import bundled from "./model-manifest.json" with { type: "json" };

type ContextWindow = "200k" | "1m";

export type ManifestProfile = {
  /** More than one entry is a choice; a single `1m` is a fixed 1M window
   *  that takes no `[1m]` suffix. */
  windows: ContextWindow[];
  defaultWindow?: ContextWindow;
  efforts: Effort[];
  fastMode: boolean;
  /** An effort the picker offers but the provider runs as another. */
  effortMap?: Partial<Record<Effort, Effort>>;
};

export type ManifestModel = {
  slug: string;
  name: string;
  aliases?: string[];
  status: "current" | "legacy";
  profile: string;
  badge?: "new";
  minVersion?: string;
};

export type ModelManifest = {
  version: number;
  claude?: {
    defaults?: { chat?: string };
    profiles: Record<string, ManifestProfile>;
    /** In picker order. */
    models: ManifestModel[];
  };
};

export const BUNDLED_MANIFEST: ModelManifest = bundled as ModelManifest;

const LONG = /\[1m\]$/i;

/** The id a row resolves to, without the window suffix or a dated build —
 *  the same fold the cockpit's `familyKey` applies. */
function canonicalId(model: Pick<ProviderModel, "id" | "resolves">): string {
  return (model.resolves ?? model.id).replace(LONG, "").replace(/-\d{8}$/, "");
}

const isLong = (model: Pick<ProviderModel, "id" | "resolves">): boolean => LONG.test(model.id) || LONG.test(model.resolves ?? "");

/** The manifest model an id names — its slug, or one of its aliases (a dated
 *  build is an alias where T3 Code lists it). */
function modelOf(id: string, manifest: ModelManifest): ManifestModel | undefined {
  const key = id.replace(LONG, "").toLowerCase();
  const models = manifest.claude?.models ?? [];
  const find = (candidate: string) => models.find((model) => model.slug === candidate || model.aliases?.includes(candidate));
  return find(key) ?? find(key.replace(/-\d{8}$/, ""));
}

/** The manifest slug a Claude id or alias names — `claude-fable-5.1` and
 *  `fable` are both `claude-fable-5-1`. Undefined for an id it does not know. */
export function claudeSlugOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): string | undefined {
  return modelOf(id, manifest)?.slug;
}

/** The profile behind a Claude id — a session on a legacy model keeps one. */
export function claudeProfileOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): ManifestProfile | undefined {
  const model = modelOf(id, manifest);
  return model ? manifest.claude?.profiles[model.profile] : undefined;
}

const WINDOW_TOKENS: Record<ContextWindow, number> = { "200k": 200_000, "1m": 1_000_000 };

/**
 * The window, in tokens, of a Claude model whose profile offers only one — Opus
 * 4.8 and 4.7 are always 1M and take no `[1m]` suffix (the manifest's single
 * `1m` window; T3 Code's `fixedContextWindowTokens`). Undefined where the id
 * picks the window, or the manifest does not know it. The one rule behind the
 * published row's `contextWindow` and the driver's first meter reading.
 */
export function claudeFixedWindowOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): number | undefined {
  return fixedWindowOf(claudeProfileOf(id, manifest));
}

function fixedWindowOf(profile: ManifestProfile | undefined): number | undefined {
  return profile?.windows.length === 1 ? WINDOW_TOKENS[profile.windows[0]!] : undefined;
}

/** The effort to hand the provider for a picked one — `xhigh` runs as `max` on
 *  Opus 4.7, per the profile. Unknown models and unmapped efforts pass through. */
export function claudeEffortFor(model: string | undefined, effort: string | undefined, manifest: ModelManifest = BUNDLED_MANIFEST): string | undefined {
  if (!model || !effort) return effort;
  return claudeProfileOf(model, manifest)?.effortMap?.[effort as Effort] ?? effort;
}

/** Dotted versions compared numerically; missing parts are zero. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function inWindow(model: ProviderModel, long: boolean): ProviderModel {
  if (long) return { ...model, id: `${model.id}[1m]`, resolves: `${model.resolves ?? model.id}[1m]` };
  return { ...model, id: model.id.replace(LONG, ""), resolves: (model.resolves ?? model.id).replace(LONG, "") };
}

/** One manifest model's published rows, the default window's marked. */
function rowsOf(entry: ManifestModel, profile: ManifestProfile, listed: readonly ProviderModel[]): ProviderModel[] {
  const fill = (model: ProviderModel): ProviderModel => ({ ...model, efforts: model.efforts.length > 0 ? model.efforts : profile.efforts });
  const long = listed.find(isLong);
  const standard = listed.find((model) => !isLong(model));
  const declared: ProviderModel = {
    id: entry.slug,
    label: entry.name.replace(/^Claude /, ""),
    isDefault: false,
    hidden: false,
    hiddenByUser: false,
    legacy: false,
    // The provider runs it — that is why the manifest lists it — so the
    // surfaces may trust its efforts the way they trust a listed row's.
    source: "provider",
    efforts: profile.efforts,
    resolves: entry.slug,
    fastMode: profile.fastMode,
  };
  if (profile.windows.length < 2) {
    const fixed = fixedWindowOf(profile);
    return [{ ...fill(standard ?? long ?? declared), ...(fixed ? { contextWindow: fixed } : {}) }];
  }
  const short = standard ?? (long ? inWindow(long, false) : declared);
  const longRow = long ?? inWindow(short, true);
  // BOTH WINDOWS ARE ROWS, the default one marked. The standard row used to be
  // dropped wherever 1M was the default, which took the 200k choice away.
  const defaultLong = profile.defaultWindow === "1m";
  return [short, longRow].map((model) =>
    isLong(model) === defaultLong ? { ...fill(model), defaultWindow: true } : fill(model),
  );
}

/**
 * The CLI's rows put through the manifest — see the header. Pure; manifest
 * models first in manifest order, then any row the manifest does not know, as
 * listed.
 */
export function applyModelManifest(
  models: readonly ProviderModel[],
  manifest: ModelManifest = BUNDLED_MANIFEST,
  cliVersion?: string,
): ProviderModel[] {
  const claude = manifest.claude;
  if (!claude || models.length === 0) return [...models];
  const claimed = new Set<ProviderModel>();
  const bySlug = new Map<string, ProviderModel[]>();
  for (const entry of claude.models) {
    const profile = claude.profiles[entry.profile];
    if (!profile) continue;
    const listed = models.filter((model) => !claimed.has(model) && modelOf(canonicalId(model), manifest)?.slug === entry.slug);
    for (const model of listed) claimed.add(model);
    const tooOld = cliVersion !== undefined && entry.minVersion !== undefined && compareVersions(cliVersion, entry.minVersion) < 0;
    bySlug.set(
      entry.slug,
      rowsOf(entry, profile, listed).map((model) => ({
        ...model,
        legacy: entry.status === "legacy",
        ...(entry.badge ? { badge: entry.badge } : {}),
        ...(tooOld ? { hidden: true } : {}),
      })),
    );
  }
  const rest = models.filter((model) => !claimed.has(model));
  // The manifest's default when it is offered, else the model the CLI calls
  // default, else whatever unknown row the CLI marked.
  const offered = (slug: string | undefined) => (slug && bySlug.get(slug)?.some((model) => !model.hidden) ? slug : undefined);
  const cliDefault = models.find((model) => model.isDefault);
  const defaultSlug = offered(claude.defaults?.chat) ?? offered(cliDefault && modelOf(canonicalId(cliDefault), manifest)?.slug);
  const out: ProviderModel[] = [];
  for (const [slug, rows] of bySlug) {
    const single = rows.length === 1;
    for (const model of rows) out.push({ ...model, isDefault: slug === defaultSlug && (single || model.defaultWindow === true) });
  }
  for (const model of rest) out.push(defaultSlug ? { ...model, isDefault: false } : model);
  return out;
}

/** The default row's id when it is a long one, else nothing — the single rule
 *  behind both the picker's default and the claim's fallback. */
export function longDefaultOf(models: readonly Pick<ProviderModel, "id" | "isDefault">[]): string | undefined {
  const fallback = models.find((model) => model.isDefault);
  return fallback && LONG.test(fallback.id) ? fallback.id : undefined;
}
