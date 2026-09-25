import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import {
  applyModelManifest,
  BUNDLED_MANIFEST,
  claudeEffortFor,
  claudeFixedWindowOf,
  claudeProfileOf,
  longDefaultOf,
  type ModelManifest,
} from "../src/model-manifest";

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  source: "provider",
  efforts: ["high"],
  fastMode: false,
  ...extra,
});

/** Claude Code 2.1.280's catalogue as `parseClaudeModels` hands it over: the
 *  `default` row already folded into the `opus[1m]` it resolves to. */
const CATALOGUE_2_1_280 = [
  row("opus[1m]", { resolves: "claude-opus-5-5[1m]", label: "Opus (1M context)", isDefault: true }),
  row("claude-fable-5[1m]", { resolves: "claude-fable-5[1m]", label: "Fable" }),
  row("sonnet", { resolves: "claude-sonnet-5", label: "Sonnet" }),
  row("sonnet[1m]", { resolves: "claude-sonnet-5[1m]", label: "Sonnet 5 (1M context)" }),
  row("haiku", { resolves: "claude-haiku-4-5-20251001", label: "Haiku", efforts: [] }),
];

const canonical = (model: ProviderModel) => (model.resolves ?? model.id).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

describe("T3 Code's list, applied to the 2.1.280 catalogue", () => {
  const out = applyModelManifest(CATALOGUE_2_1_280, BUNDLED_MANIFEST, "2.1.280");
  const bySlug = (slug: string) => out.filter((model) => canonical(model) === slug);

  test("current and legacy come from the manifest's status, in its order", () => {
    const families = (legacy: boolean) => [...new Set(out.filter((model) => model.legacy === legacy).map(canonical))];
    expect(families(false)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(families(true)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  test("the manifest's default wins over the CLI's: Fable 5.1 on 1M", () => {
    expect(out.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["claude-fable-5-1[1m]"]);
    expect(longDefaultOf(out)).toBe("claude-fable-5-1[1m]");
  });

  test("Opus 5.5 carries the CLI's row and label, and the `new` badge", () => {
    expect(bySlug("claude-opus-5-5")).toMatchObject([
      { id: "opus", badge: "new", isDefault: false },
      { id: "opus[1m]", label: "Opus (1M context)", badge: "new", defaultWindow: true, isDefault: false },
    ]);
    expect(new Set(out.filter((model) => model.badge).map(canonical))).toEqual(new Set(["claude-opus-5-5"]));
  });

  test("Sonnet 5 publishes BOTH windows, 200k marked as its default", () => {
    expect(bySlug("claude-sonnet-5").map((model) => [model.id, model.defaultWindow ?? false])).toEqual([
      ["sonnet", true],
      ["sonnet[1m]", false],
    ]);
  });

  test("a model the CLI does not list is still a row per window, named from the manifest, 1M marked default", () => {
    expect(bySlug("claude-opus-5")).toMatchObject([
      { id: "claude-opus-5", label: "Opus 5", resolves: "claude-opus-5", source: "provider", fastMode: true },
      { id: "claude-opus-5[1m]", label: "Opus 5", resolves: "claude-opus-5[1m]", source: "provider", fastMode: true, defaultWindow: true },
    ]);
    expect(bySlug("claude-opus-5")[0]!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A fixed-1M profile takes no suffix; a 200k-only one has one row.
    expect(bySlug("claude-opus-4-8").map((model) => model.id)).toEqual(["claude-opus-4-8"]);
    expect(bySlug("claude-opus-4-5").map((model) => model.id)).toEqual(["claude-opus-4-5"]);
  });

  test("Fable 5 is kept, under Legacy, rather than dropped", () => {
    expect(bySlug("claude-fable-5").map((model) => model.id)).toEqual(["claude-fable-5", "claude-fable-5[1m]"]);
    expect(bySlug("claude-fable-5")[1]).toMatchObject({ label: "Fable", legacy: true, defaultWindow: true });
  });

  test("a listed row keeps its own efforts; an empty list is filled from the profile", () => {
    expect(bySlug("claude-sonnet-5")[0]!.efforts).toEqual(["high"]);
    expect(bySlug("claude-haiku-4-5")).toMatchObject([{ id: "haiku", efforts: [], legacy: true }]);
  });

  test("nothing is hidden when the installed CLI is new enough", () => {
    expect(out.filter((model) => model.hidden)).toEqual([]);
  });
});

describe("minVersion", () => {
  test("hides Opus 5.5 under 2.1.279, and the default stays Fable 5.1", () => {
    const out = applyModelManifest(CATALOGUE_2_1_280, BUNDLED_MANIFEST, "2.1.279");
    // Both of its window rows.
    expect(out.filter((model) => model.hidden).map(canonical)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(longDefaultOf(out)).toBe("claude-fable-5-1[1m]");
  });

  test("an unknown version hides nothing", () => {
    expect(applyModelManifest(CATALOGUE_2_1_280, BUNDLED_MANIFEST).some((model) => model.hidden)).toBe(false);
  });

  test("a hidden manifest default falls back to the CLI's own", () => {
    const out = applyModelManifest(CATALOGUE_2_1_280, BUNDLED_MANIFEST, "2.1.200");
    // Fable 5.1 needs 2.1.257, Opus 5.5 2.1.280: the CLI's default model is
    // hidden too, so nothing listed is default.
    expect(out.some((model) => model.isDefault)).toBe(false);
    const manifest: ModelManifest = { ...BUNDLED_MANIFEST, claude: { ...BUNDLED_MANIFEST.claude!, defaults: {} } };
    expect(longDefaultOf(applyModelManifest(CATALOGUE_2_1_280, manifest, "2.1.280"))).toBe("opus[1m]");
  });
});

describe("the CLI wins what it states", () => {
  test("a listed Fable 5.1 row — even under an alias — replaces the manifest's", () => {
    const out = applyModelManifest([row("fable", { label: "Fable (live)" })], BUNDLED_MANIFEST);
    const fable = out.filter((model) => model.label === "Fable (live)");
    expect(fable.map((model) => model.id)).toEqual(["fable", "fable[1m]"]);
    expect(out.some((model) => model.id === "claude-fable-5-1[1m]")).toBe(false);
  });

  test("a model the manifest does not know rides through after the manifest's", () => {
    const out = applyModelManifest([row("claude-mystery-9")], BUNDLED_MANIFEST);
    expect(out.at(-1)).toMatchObject({ id: "claude-mystery-9", legacy: false });
  });

  test("an empty list stays empty — the CLI could not be asked", () => {
    expect(applyModelManifest([], BUNDLED_MANIFEST)).toEqual([]);
  });
});

describe("a legacy profile", () => {
  test("a session on legacy Fable 5 still resolves its profile", () => {
    expect(claudeProfileOf("claude-fable-5")?.defaultWindow).toBe("1m");
  });
});

describe("a fixed window is published, not guessed from the suffix (#914)", () => {
  const out = applyModelManifest(CATALOGUE_2_1_280, BUNDLED_MANIFEST, "2.1.280");
  const windowOf = (slug: string) => out.filter((model) => canonical(model) === slug).map((model) => model.contextWindow);

  test("bare Opus 4.8 and 4.7 are 1M; a 200k-only model is 200k; a model with a choice says nothing", () => {
    expect(windowOf("claude-opus-4-8")).toEqual([1_000_000]);
    expect(windowOf("claude-opus-4-7")).toEqual([1_000_000]);
    expect(windowOf("claude-haiku-4-5")).toEqual([200_000]);
    expect(windowOf("claude-sonnet-5")).toEqual([undefined, undefined]);
  });

  test("claudeFixedWindowOf reads the same profile, by slug or alias", () => {
    expect(claudeFixedWindowOf("claude-opus-4-8")).toBe(1_000_000);
    expect(claudeFixedWindowOf("opus-4.7")).toBe(1_000_000);
    expect(claudeFixedWindowOf("haiku")).toBe(200_000);
    expect(claudeFixedWindowOf("opus[1m]")).toBeUndefined();
    expect(claudeFixedWindowOf("claude-mystery-9")).toBeUndefined();
  });
});

test("an effort a model runs under another name is mapped for the provider", () => {
  expect(claudeEffortFor("claude-opus-4-7", "xhigh")).toBe("max");
  expect(claudeEffortFor("claude-sonnet-4-6[1m]", "max")).toBe("high");
  expect(claudeEffortFor("claude-opus-5-5[1m]", "xhigh")).toBe("xhigh");
  expect(claudeEffortFor("claude-mystery-9", "max")).toBe("max");
});

test("the bundled manifest is well-formed: every model has a profile, the default is a model, no alias is claimed twice", () => {
  const claude = BUNDLED_MANIFEST.claude!;
  const seen = new Set<string>();
  for (const model of claude.models) {
    expect(claude.profiles[model.profile], model.slug).toBeDefined();
    for (const alias of [model.slug, ...(model.aliases ?? [])]) {
      expect(seen.has(alias), alias).toBe(false);
      seen.add(alias);
    }
  }
  expect(claude.models.some((model) => model.slug === claude.defaults?.chat)).toBe(true);
});
