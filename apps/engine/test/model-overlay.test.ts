import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { applyModelOverlay } from "../src/model-overlay";

/** A provider row, with only the fields a case cares about spelled out. */
function row(id: string, extra: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id,
    label: id,
    isDefault: false,
    hidden: false,
    hiddenByUser: false,
    efforts: [],
    fastMode: false,
    source: "provider",
    ...extra,
  };
}

const EMPTY = { hidden: [], order: [], custom: [] };

describe("hiding", () => {
  test("marks the row rather than dropping it", () => {
    // The Models tab has to be able to show a hidden row in order to offer
    // un-hiding it, and a session already running one still has to resolve its
    // efforts. Dropping it here would take both away.
    const models = applyModelOverlay([row("sonnet"), row("opus[1m]")], { ...EMPTY, hidden: ["sonnet"] });
    expect(models.map((model) => model.id)).toEqual(["sonnet", "opus[1m]"]);
    expect(models.map((model) => model.hiddenByUser)).toEqual([true, false]);
  });

  test("a hide for a model the provider has withdrawn is simply not there", () => {
    expect(applyModelOverlay([row("sonnet")], { ...EMPTY, hidden: ["gone"] })).toEqual([row("sonnet")]);
  });

  test("never touches the provider's own `hidden`", () => {
    // The two fields answer different questions and a surface reads them
    // differently — `splitGenerations` files provider-hidden rows as legacy.
    const [model] = applyModelOverlay([row("old", { hidden: true })], { ...EMPTY, hidden: ["old"] });
    expect(model).toMatchObject({ hidden: true, hiddenByUser: true });
  });
});

describe("models somebody typed in", () => {
  const claude = [row("sonnet", { efforts: ["low", "high"] }), row("opus[1m]", { efforts: ["high", "max"], fastMode: true })];

  test("appends a row for an id the provider does not publish", () => {
    const models = applyModelOverlay(claude, { ...EMPTY, custom: [{ id: "claude-fable-5-1" }] });
    expect(models.map((model) => model.id)).toEqual(["sonnet", "opus[1m]", "claude-fable-5-1"]);
  });

  test("the added row claims nothing on the reader's behalf", () => {
    const [added] = applyModelOverlay([], { ...EMPTY, custom: [{ id: "claude-fable-5-1" }] });
    expect(added).toMatchObject({
      id: "claude-fable-5-1",
      // No name is invented for a row nobody published.
      label: "claude-fable-5-1",
      // `isDefault` decides what runs when a session names no model.
      isDefault: false,
      // Fast mode is per-model and this one was never published.
      fastMode: false,
      source: "user",
    });
    // No `resolves`: inventing one would fold this row into a family it may not
    // belong to.
    expect(added).not.toHaveProperty("resolves");
  });

  test("a label is used when one was given", () => {
    const [added] = applyModelOverlay([], { ...EMPTY, custom: [{ id: "claude-fable-5-1", label: "Fable 5.1" }] });
    expect(added!.label).toBe("Fable 5.1");
  });

  test("efforts are the union of the driver's, NOT the empty list", () => {
    // The empty list looks honest and is the one wrong answer: the composer
    // drops any effort the target row does not list, so `[]` would offer only
    // Auto and silently strip a level on the row where somebody typed an id
    // precisely in order to push a new model hard.
    const models = applyModelOverlay(claude, { ...EMPTY, custom: [{ id: "claude-fable-5-1" }] });
    const added = models.at(-1)!;
    expect(added.id).toBe("claude-fable-5-1");
    expect([...added.efforts].sort()).toEqual(["high", "low", "max"]);
  });

  test("with nothing published to draw on, the union is empty and that is fine", () => {
    const [added] = applyModelOverlay([], { ...EMPTY, custom: [{ id: "x" }] });
    expect(added!.efforts).toEqual([]);
  });

  test("a hide applies to an added row too", () => {
    const [added] = applyModelOverlay([], { ...EMPTY, custom: [{ id: "x" }], hidden: ["x"] });
    expect(added!.hiddenByUser).toBe(true);
  });
});

describe("when the provider catches up", () => {
  test("a published id wins over the typed one", () => {
    // The whole point of the escape hatch is that it stops being needed.
    const published = row("claude-fable-5-1", { label: "Fable 5.1", efforts: ["max"], isDefault: true });
    const models = applyModelOverlay([published], { ...EMPTY, custom: [{ id: "claude-fable-5-1", label: "mine" }] });
    expect(models).toEqual([published]);
  });

  test("a published ALIAS resolving to the typed id also covers it", () => {
    // `fable` → `claude-fable-5-1` is the same model arriving under the name the
    // provider prefers, so listing both would be one model twice.
    const alias = row("fable", { resolves: "claude-fable-5-1" });
    const models = applyModelOverlay([alias], { ...EMPTY, custom: [{ id: "claude-fable-5-1" }] });
    expect(models.map((model) => model.id)).toEqual(["fable"]);
  });
});

describe("order", () => {
  const models = [row("a"), row("b"), row("c")];

  test("named ids lead, in the sequence they were named", () => {
    expect(applyModelOverlay(models, { ...EMPTY, order: ["c", "a"] }).map((model) => model.id)).toEqual(["c", "a", "b"]);
  });

  test("is PARTIAL — anything unnamed keeps the provider's own order", () => {
    // A total order would have to be rewritten every time the provider ships a
    // model, and until somebody did, the new model would sort last.
    expect(applyModelOverlay(models, { ...EMPTY, order: ["c"] }).map((model) => model.id)).toEqual(["c", "a", "b"]);
  });

  test("an id for a withdrawn model is skipped, not thrown over", () => {
    expect(applyModelOverlay(models, { ...EMPTY, order: ["gone", "b"] }).map((model) => model.id)).toEqual(["b", "a", "c"]);
  });

  test("an id repeated in the order is placed once", () => {
    expect(applyModelOverlay(models, { ...EMPTY, order: ["b", "b"] }).map((model) => model.id)).toEqual(["b", "a", "c"]);
  });

  test("added rows take part", () => {
    const ordered = applyModelOverlay(models, { ...EMPTY, custom: [{ id: "mine" }], order: ["mine"] });
    expect(ordered.map((model) => model.id)).toEqual(["mine", "a", "b", "c"]);
  });
});

test("an untouched overlay changes nothing at all", () => {
  // The property that makes this feature shippable before any UI exists.
  const models = [row("sonnet", { efforts: ["low"] }), row("opus[1m]", { isDefault: true })];
  expect(applyModelOverlay(models, EMPTY)).toEqual(models);
});

describe("the reader's default", () => {
  const listed = () => [row("fable[1m]", { isDefault: true }), row("opus[1m]"), row("old", { hidden: true })];

  test("moves `isDefault` to the chosen row and off Telar's pick", () => {
    const models = applyModelOverlay(listed(), { ...EMPTY, default: "opus[1m]" });
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["opus[1m]"]);
  });

  test("a choice the list no longer carries leaves Telar's pick standing", () => {
    // A withdrawn model must fall back, never become a default nobody can run.
    for (const chosen of ["gone", "old"]) {
      const models = applyModelOverlay(listed(), { ...EMPTY, default: chosen });
      expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["fable[1m]"]);
    }
  });

  test("a hand-typed row never becomes the default", () => {
    const models = applyModelOverlay(listed(), { ...EMPTY, custom: [{ id: "typed" }], default: "typed" });
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["fable[1m]"]);
  });
});
