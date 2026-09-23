/**
 * The decidable parts of the Models tab, as pure functions.
 *
 * Same split `publishableEnv` already uses on the sibling card: this repo has no
 * component-render tests, so the rules worth pinning are the ones that can be
 * lifted out of the JSX.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { addableModelId, canBeDefault, modelCountLine, reorderIds } from "./provider-models-tab";

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  source: "provider",
  efforts: [],
  fastMode: false,
  ...extra,
});

describe("addableModelId", () => {
  const models = [model("sonnet", { label: "Sonnet", resolves: "claude-sonnet-5" }), model("opus[1m]", { label: "Opus" })];

  test("accepts an id the provider does not publish, trimmed", () => {
    expect(addableModelId("  claude-fable-5-1 ", models, [], "Claude")).toEqual({ id: "claude-fable-5-1" });
  });

  test("refuses a blank rather than filing one", () => {
    expect(addableModelId("   ", models, [], "Claude")).toEqual({ error: "Type a model id first." });
  });

  test("refuses an id the provider already lists, and says which row", () => {
    // Nothing-happens-on-press is the failure people retype their way around.
    expect(addableModelId("opus[1m]", models, [], "Claude")).toEqual({
      error: "Claude already lists this, as “Opus”.",
    });
  });

  test("refuses an id a published ALIAS resolves to", () => {
    // `sonnet` → `claude-sonnet-5` is the same model under the name the provider
    // prefers; the engine would drop the duplicate silently, so catch it here.
    expect(addableModelId("claude-sonnet-5", models, [], "Claude")).toEqual({
      error: "Claude already lists this, as “Sonnet”.",
    });
  });

  test("refuses one already added", () => {
    expect(addableModelId("mine", models, [{ id: "mine" }], "Claude")).toEqual({ error: "You have already added this one." });
  });

  test("a row somebody added does not block re-adding by the published check", () => {
    // Only PUBLISHED rows count as coverage; the custom list has its own check
    // with its own sentence.
    const withUser = [...models, model("mine", { source: "user" })];
    expect(addableModelId("mine", withUser, [], "Claude")).toEqual({ id: "mine" });
  });
});

describe("modelCountLine", () => {
  test("counts what the provider gave separately from what you added", () => {
    const models = [model("a"), model("b"), model("mine", { source: "user" })];
    expect(modelCountLine(models, "Codex")).toBe("2 from Codex · 1 you added");
  });

  test("clauses that are not true are left out entirely", () => {
    expect(modelCountLine([model("a")], "Claude")).toBe("1 from Claude");
  });

  test("hidden rows are counted, because they are still there to un-hide", () => {
    const models = [model("a", { hiddenByUser: true }), model("b")];
    expect(modelCountLine(models, "Claude")).toBe("2 from Claude · 1 hidden");
  });
});

describe("reorderIds", () => {
  const rendered = ["a", "b", "c", "d"];

  test("moves a row one place up", () => {
    expect(reorderIds(rendered, [], "c", -1)).toEqual(["a", "c", "b"]);
  });

  test("moves a row one place down", () => {
    expect(reorderIds(rendered, [], "b", 1)).toEqual(["a", "c", "b"]);
  });

  test("names only a PREFIX, so a model shipped next week still lands where the provider put it", () => {
    // The whole point of a partial order. Swapping the first two must not pin
    // the entire list.
    expect(reorderIds(rendered, [], "a", 1)).toEqual(["b", "a"]);
  });

  test("the named prefix never shrinks", () => {
    // Otherwise this reorder would silently un-pin rows an earlier one placed.
    expect(reorderIds(rendered, ["a", "b", "c", "d"], "a", 1)).toEqual(["b", "a", "c", "d"]);
  });

  test("a move off either end changes nothing", () => {
    expect(reorderIds(rendered, ["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(reorderIds(rendered, ["a", "b"], "d", 1)).toEqual(["a", "b"]);
  });

  test("an id that is not on screen changes nothing", () => {
    expect(reorderIds(rendered, ["a"], "gone", -1)).toEqual(["a"]);
  });
});

test("only a row the provider still publishes is offered as the default", () => {
  expect(canBeDefault(model("opus[1m]"))).toBe(true);
  expect(canBeDefault(model("withdrawn", { hidden: true }))).toBe(false);
  expect(canBeDefault(model("typed", { source: "user" }))).toBe(false);
  // Hidden from the picker is curation, not withdrawal: it can still be the default.
  expect(canBeDefault(model("curated", { hiddenByUser: true }))).toBe(true);
});
