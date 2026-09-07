/**
 * THE MODEL MANIFEST — facts about models the installed CLI does not publish.
 *
 * WHY IT EXISTS, measured on this app: Claude Code 2.1.259 lists
 * `claude-fable-5[1m]` and `claude-fable-5-1` but no `claude-fable-5-1[1m]`,
 * even though that id is accepted and reports a 1M window. The cockpit's window
 * toggle is derived purely from the `[1m]` rows the provider lists (see
 * apps/web/lib/model-families.ts, "AND NOTHING ELSE COUNTS"), so Fable 5.1
 * offered no 1M at all and a session on it read 444k / 200k. T3 Code carries
 * the same fact in its own manifest (a `contextWindow` option on the `fable-5`
 * profile); this is Telar's, shaped for the one gap it fills today.
 *
 * WHAT IT DOES, in order:
 *
 *  1. DECLARE models the CLI does not list. Measured on this app: the same
 *     2.1.259 binary listed `claude-fable-5-1` in the morning and not in the
 *     afternoon — the list is served from an entitlement lookup, not baked in —
 *     while a session on that id kept running fine. A declared model is a real
 *     row (`source: "provider"`, since the provider does run it) with the
 *     efforts the manifest states; a listed row of the same canonical id
 *     always wins, so a declaration goes quiet the moment the CLI catches up.
 *
 *  2. SYNTHESIZE the missing `<id>[1m]` row for a model (listed or declared)
 *     whose profile has a long window, then publish only long-window Claude
 *     rows. This app no longer offers the 200k variants or Haiku.
 *
 * No new protocol field: a selected row is still the provider's own model id,
 * with the context window encoded in Claude Code's `[1m]` suffix.
 *
 * BUNDLED, NO NETWORK. The engine makes no outbound fetches today and this does
 * not start; updating the manifest is shipping a build, which for this app is a
 * nightly. A remote refresh (T3 Code's shape: fetch the same file from a public
 * URL, cache to disk, bundled copy as fallback) is a follow-up on top of this,
 * not a prerequisite — the update feed's bucket is the natural origin.
 *
 * PRECEDENCE: the CLI wins. A `[1m]` row the provider DOES list is never
 * duplicated or overwritten; the manifest only fills in what is absent.
 */
import type { Effort, ProviderModel } from "@telar/engine-client";
import bundled from "./model-manifest.json" with { type: "json" };

export type ModelManifest = {
  version: number;
  claude?: {
    /** `defaultLong`: the provider ships this profile 1M by default, so the
     *  synthesized `[1m]` row is marked as the model's default window. */
    profiles: Record<string, { longWindow: boolean; defaultLong?: boolean }>;
    /** Canonical wire id (no `[1m]`, no dated build) → profile key. */
    models: Record<string, string>;
    /** Models to list even when the CLI does not. Keyed on the canonical id;
     *  a listed row with the same canonical id suppresses the declaration. */
    declare?: Array<{ id: string; label: string; description?: string; efforts: Effort[] }>;
  };
};

export const BUNDLED_MANIFEST: ModelManifest = bundled as ModelManifest;

/** The id a row resolves to, without the window suffix or a dated build —
 *  the same fold the cockpit's `familyKey` applies, so the manifest keys on
 *  exactly what the picker groups by. */
function canonicalId(model: Pick<ProviderModel, "id" | "resolves">): string {
  return (model.resolves ?? model.id).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

const isLong = (model: Pick<ProviderModel, "id" | "resolves">): boolean =>
  /\[1m\]$/i.test(model.id) || /\[1m\]$/i.test(model.resolves ?? "");

function publishClaudeModel(model: ProviderModel, manifest: NonNullable<ModelManifest["claude"]>): boolean {
  const profile = manifest.profiles[manifest.models[canonicalId(model)] ?? ""];
  if (!profile) return true;
  return profile.longWindow === true && isLong(model);
}

/**
 * Add the `[1m]` rows the provider left out, per the manifest. Pure; returns a
 * new array with each synthesized row placed right after its standard sibling
 * so the catalogue's own order is kept.
 */
export function applyModelManifest(models: readonly ProviderModel[], manifest: ModelManifest = BUNDLED_MANIFEST): ProviderModel[] {
  const claude = manifest.claude;
  if (!claude) return [...models];
  // Step 1: declared models the CLI left out, appended after the listed rows.
  const listedCanonical = new Set(models.map(canonicalId));
  const declared: ProviderModel[] = (claude.declare ?? [])
    .filter((entry) => !listedCanonical.has(canonicalId({ id: entry.id })))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: false,
      hidden: false,
      hiddenByUser: false,
      // The provider runs it — that is the whole reason to declare it — so it
      // is a provider row, not a hand-typed `user` one: the surfaces may trust
      // its efforts the way they trust a listed row's.
      source: "provider",
      efforts: entry.efforts,
      resolves: entry.id,
      fastMode: false,
    }));
  const withDeclared = [...models, ...declared];
  const defaultCanonical = new Set(withDeclared.filter((model) => model.isDefault).map(canonicalId));
  // Step 2: every canonical id that already has a long row, listed by the provider.
  const alreadyLong = new Set(withDeclared.filter(isLong).map(canonicalId));
  const out: ProviderModel[] = [];
  for (const model of withDeclared) {
    out.push(model);
    if (isLong(model)) continue;
    const canonical = canonicalId(model);
    if (alreadyLong.has(canonical)) continue;
    const profile = claude.profiles[claude.models[canonical] ?? ""];
    if (!profile?.longWindow) continue;
    alreadyLong.add(canonical);
    out.push({
      ...model,
      id: `${model.id}[1m]`,
      // Resolves to the long form of what the standard row resolves to, so the
      // cockpit's family fold puts both rows under one name.
      resolves: `${model.resolves ?? model.id}[1m]`,
      // If the provider named the filtered-out 200k row as default, carry that
      // default to the only row Telar now publishes for this family.
      isDefault: model.isDefault,
      // A fact for the picker to show, not a choice made on anyone's behalf.
      ...(profile.defaultLong ? { defaultWindow: true } : {}),
    });
  }
  return out
    .filter((model) => publishClaudeModel(model, claude))
    .map((model) =>
      isLong(model) && defaultCanonical.has(canonicalId(model))
        ? { ...model, isDefault: true }
        : model,
    );
}
