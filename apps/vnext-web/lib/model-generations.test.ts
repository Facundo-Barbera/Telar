/**
 * The current/legacy split.
 *
 * Pinned against the REAL lists both providers report, because the whole point
 * of the rule is that it survives a provider shipping a new family without
 * anybody editing this repository.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { defaultModelId, effortsFor, modelVersion, splitGenerations } from "./model-generations";

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  efforts: [],
  ...extra,
});

describe("modelVersion", () => {
  test("reads the version out of both providers' id shapes", () => {
    expect(modelVersion("gpt-5.6-sol")).toBeCloseTo(5.06, 5);
    expect(modelVersion("gpt-5.5")).toBeCloseTo(5.05, 5);
    // Anthropic separates with a dash where OpenAI uses a dot.
    expect(modelVersion("claude-opus-4-8")).toBeCloseTo(4.08, 5);
    expect(modelVersion("claude-opus-5")).toBe(5);
    // A third component is a patch level and does not change the generation.
    expect(modelVersion("gpt-5.4-mini")).toBeCloseTo(5.04, 5);
  });

  test("an id with no number is unreadable rather than zero", () => {
    // Zero would sort it below everything and hide it. Undefined means
    // "current", which is the safe direction to fail in.
    expect(modelVersion("some-experimental-thing")).toBeUndefined();
  });
});

describe("splitGenerations", () => {
  test("Codex's real seven split into the 5.6 family and everything older", () => {
    // Exactly what `model/list` answered on this machine.
    const models = [
      model("gpt-5.6-sol", { isDefault: true }),
      model("gpt-5.6-terra"),
      model("gpt-5.6-luna"),
      model("gpt-5.5"),
      model("gpt-5.4"),
      model("gpt-5.4-mini"),
      model("gpt-5.3-codex-spark"),
    ];
    const split = splitGenerations(models);
    expect(split.current.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  });

  test("Claude's list splits at the 5 line", () => {
    const split = splitGenerations([
      model("claude-opus-5", { isDefault: true }),
      model("claude-sonnet-5"),
      model("claude-opus-4-8"),
      model("claude-haiku-4-5"),
    ]);
    expect(split.current.map((entry) => entry.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
  });

  test("a model the provider hid is legacy no matter what its version says", () => {
    // `hidden` is the provider saying "do not show this"; the version rule is
    // ours. The provider's wins.
    const split = splitGenerations([model("gpt-5.6-sol", { isDefault: true }), model("gpt-5.6-secret", { hidden: true })]);
    expect(split.current.map((entry) => entry.id)).toEqual(["gpt-5.6-sol"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["gpt-5.6-secret"]);
  });

  test("an unreadable default leaves everything current rather than hiding on a guess", () => {
    // Being shown a model you did not need is a far smaller failure than hiding
    // one you did.
    const split = splitGenerations([model("mystery", { isDefault: true }), model("gpt-5.4")]);
    expect(split.current).toHaveLength(2);
    expect(split.legacy).toEqual([]);
  });

  test("an empty catalogue is empty, not a crash", () => {
    expect(splitGenerations([])).toEqual({ current: [], legacy: [] });
  });
});

describe("defaultModelId and effortsFor", () => {
  test("the provider's default wins; failing that, the first visible one", () => {
    expect(defaultModelId([model("a"), model("b", { isDefault: true })])).toBe("b");
    expect(defaultModelId([model("hidden-one", { hidden: true }), model("a")])).toBe("a");
    expect(defaultModelId([])).toBeUndefined();
  });

  test("efforts are per model, and an unknown model has none rather than a guess", () => {
    // Codex reports six levels for its newest model and four for an older one.
    // Offering a level a model does not have fails the whole turn.
    const models = [model("new", { efforts: ["low", "high", "ultra"] }), model("old", { efforts: ["low", "high"] })];
    expect(effortsFor(models, "new")).toEqual(["low", "high", "ultra"]);
    expect(effortsFor(models, "old")).toEqual(["low", "high"]);
    expect(effortsFor(models, "gone")).toEqual([]);
  });
});

describe("effortLabel", () => {
  test("a level this cockpit has never heard of is title-cased, not dropped", async () => {
    // Codex reports `ultra` on its newest model. The word stays the provider's;
    // only the casing is ours, so it sits in the list like the others.
    const { effortLabel } = await import("./models");
    expect(effortLabel("ultra")).toBe("Ultra");
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel(undefined)).toBe("Auto");
  });
});
