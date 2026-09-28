import type { Effort, ProviderModel } from "@telar/engine-client";
import bundled from "./manifest.json" with { type: "json" };

type ContextWindow = "200k" | "1m";

type ManifestProfile = {
  windows: ContextWindow[];
  defaultWindow?: ContextWindow;
  efforts: Effort[];
  fastMode: boolean;
  effortMap?: Partial<Record<Effort, Effort>>;
};

type ManifestModel = {
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
    models: ManifestModel[];
  };
};

export const BUNDLED_MANIFEST: ModelManifest = bundled as ModelManifest;

const LONG = /\[1m\]$/i;

function canonicalId(model: Pick<ProviderModel, "id" | "resolves">): string {
  return (model.resolves ?? model.id).replace(LONG, "").replace(/-\d{8}$/, "");
}

const isLong = (model: Pick<ProviderModel, "id" | "resolves">): boolean => LONG.test(model.id) || LONG.test(model.resolves ?? "");

function modelOf(id: string, manifest: ModelManifest): ManifestModel | undefined {
  const key = id.replace(LONG, "").toLowerCase();
  const models = manifest.claude?.models ?? [];
  const find = (candidate: string) => models.find((model) => model.slug === candidate || model.aliases?.includes(candidate));
  return find(key) ?? find(key.replace(/-\d{8}$/, ""));
}

export function claudeSlugOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): string | undefined {
  return modelOf(id, manifest)?.slug;
}

export function claudeProfileOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): ManifestProfile | undefined {
  const model = modelOf(id, manifest);
  return model ? manifest.claude?.profiles[model.profile] : undefined;
}

const WINDOW_TOKENS: Record<ContextWindow, number> = { "200k": 200_000, "1m": 1_000_000 };

export function claudeFixedWindowOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): number | undefined {
  return fixedWindowOf(claudeProfileOf(id, manifest));
}

export function claudeWindowTokensOf(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): number | undefined {
  const profile = claudeProfileOf(id, manifest);
  if (!profile) return undefined;
  const fixed = fixedWindowOf(profile);
  if (fixed) return fixed;
  const window: ContextWindow = LONG.test(id) ? "1m" : "200k";
  return profile.windows.includes(window) ? WINDOW_TOKENS[window] : undefined;
}

function fixedWindowOf(profile: ManifestProfile | undefined): number | undefined {
  return profile?.windows.length === 1 ? WINDOW_TOKENS[profile.windows[0]!] : undefined;
}

export function claudeEffortFor(model: string | undefined, effort: string | undefined, manifest: ModelManifest = BUNDLED_MANIFEST): string | undefined {
  if (!model || !effort) return effort;
  return claudeProfileOf(model, manifest)?.effortMap?.[effort as Effort] ?? effort;
}

export function legacyLongSpelling(id: string, manifest: ModelManifest = BUNDLED_MANIFEST): string {
  if (LONG.test(id) || /-\d{8}$/.test(id)) return id;
  const profile = claudeProfileOf(id, manifest);
  return profile && profile.windows.length > 1 && profile.defaultWindow === "1m" ? `${id}[1m]` : id;
}

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
  const defaultLong = profile.defaultWindow === "1m";
  return [short, longRow].map((model) =>
    isLong(model) === defaultLong ? { ...fill(model), defaultWindow: true } : fill(model),
  );
}

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

export function longDefaultOf(models: readonly Pick<ProviderModel, "id" | "isDefault">[]): string | undefined {
  const fallback = models.find((model) => model.isDefault);
  return fallback && LONG.test(fallback.id) ? fallback.id : undefined;
}
