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
import { defaultModelId, modelVersion, splitGenerations } from "./model-generations";

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  source: "provider",
  efforts: [],
  fastMode: false,
  ...extra,
});

describe("modelVersion", () => {
  test("reads the version out of both providers' id shapes", () => {
    expect(modelVersion("gpt-5.6-sol")).toBeCloseTo(5.06, 5);
    expect(modelVersion("gpt-5.5")).toBeCloseTo(5.05, 5);
    // Anthropic separates with a dash where OpenAI uses a dot.
    expect(modelVersion("claude-opus-4-8")).toBeCloseTo(4.08, 5);
    expect(modelVersion("claude-opus-5")).toBe(5);
    // A point release outranks its base and stays level with the generation.
    expect(modelVersion("claude-fable-5-1")).toBeCloseTo(5.01, 5);
    expect(modelVersion("claude-fable-5-1")!).toBeGreaterThan(modelVersion("claude-fable-5")!);
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
  test("Astra arriving does not relegate the actively-used 5.6 family", () => {
    // Exactly what `model/list` answered on this machine on 2026-09-10:
    // GPT-6-Astra became the default, and under the old "older than the
    // default" rule every 5.6 model — in daily use that morning — fell behind
    // the Legacy fold. Current reaches one generation back.
    const models = [
      model("gpt-6-astra", { isDefault: true }),
      model("gpt-5.6-sol"),
      model("gpt-5.6-terra"),
      model("gpt-5.6-luna"),
      model("gpt-5.5"),
      model("gpt-5.3-codex-spark"),
    ];
    const split = splitGenerations(models);
    expect(split.current.map((entry) => entry.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["gpt-5.5", "gpt-5.3-codex-spark"]);
  });

  test("the previous generation stays current when the default IS the newest line", () => {
    // The pre-Astra catalogue: 5.6-sol default keeps 5.5 (one line back)
    // reachable, and only 5.4 and older fold away.
    const models = [
      model("gpt-5.6-sol", { isDefault: true }),
      model("gpt-5.6-terra"),
      model("gpt-5.5"),
      model("gpt-5.4"),
      model("gpt-5.4-mini"),
      model("gpt-5.3-codex-spark"),
    ];
    const split = splitGenerations(models);
    expect(split.current.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  });

  test("Claude keeps the 5 line and the generation just below it", () => {
    const split = splitGenerations([
      model("claude-opus-5", { isDefault: true }),
      model("claude-sonnet-5"),
      model("claude-opus-4-8"),
      model("claude-haiku-4-5"),
    ]);
    expect(split.current.map((entry) => entry.id)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"]);
    expect(split.legacy.map((entry) => entry.id)).toEqual(["claude-haiku-4-5"]);
  });

  test("a catalogue with no stated default files nothing as legacy", () => {
    // OpenCode's multi-connection list marks no default; the old `?? visible[0]`
    // fallback anchored the split on whichever row happened to be first, which
    // made the filing depend on catalogue order.
    const split = splitGenerations([model("openai/gpt-6-astra"), model("opencode/big-pickle"), model("opencode-go/glm-5.1")]);
    expect(split.current).toHaveLength(3);
    expect(split.legacy).toEqual([]);
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

describe("defaultModelId", () => {
  test("the provider's default wins; failing that, the first visible one", () => {
    expect(defaultModelId([model("a"), model("b", { isDefault: true })])).toBe("b");
    expect(defaultModelId([model("hidden-one", { hidden: true }), model("a")])).toBe("a");
    expect(defaultModelId([])).toBeUndefined();
  });

  // `effortsFor` used to live here and matched on `id` alone, which reported no
  // levels for a session carrying the wire id of an alias. Its replacement is
  // `rowOf(...)?.efforts` — see model-families.test.ts.
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
