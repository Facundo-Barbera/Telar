/**
 * The provider-backed catalogue.
 *
 * The parser is the part worth pinning: it crosses a version boundary, because
 * the installed `codex` is upgraded by its own updater on its own schedule.
 */
import { describe, expect, test } from "bun:test";
import { parseCodexModels, readModelCatalogue } from "../src/models";

describe("parseCodexModels", () => {
  test("reads `model/list`'s real shape, per-model efforts and all", () => {
    // Captured from the installed binary rather than imagined.
    const models = parseCodexModels({
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
        },
      ],
    });
    expect(models).toEqual([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        isDefault: true,
        hidden: false,
        efforts: ["low", "max", "ultra"],
        defaultEffort: "low",
      },
    ]);
  });

  test("a row from a newer or older codex degrades instead of throwing", () => {
    // A menu must not be able to fail because a field moved.
    expect(parseCodexModels({ data: [{ id: "x" }] })).toEqual([
      { id: "x", label: "x", isDefault: false, hidden: false, efforts: [] },
    ]);
    expect(parseCodexModels({ data: [{ displayName: "no id" }] })).toEqual([]);
    expect(parseCodexModels({})).toEqual([]);
    expect(parseCodexModels(null)).toEqual([]);
  });
});

describe("readModelCatalogue", () => {
  test("Claude is answered from the built-in list, and says so", () => {
    // The Agent SDK exposes `supportedModels()` only on a live query, which
    // means paying for a session to fill a menu. Until there is a cheaper seam
    // this is a guess, and the source field is how a surface can admit it.
    return readModelCatalogue("claude", () => 5).then((catalogue) => {
      expect(catalogue.source).toBe("builtin");
      expect(catalogue.models.find((model) => model.isDefault)?.id).toBe("claude-opus-5");
      expect(catalogue.readAt).toBe(5);
    });
  });

  test("Codex that cannot be asked returns NOTHING, with the reason", async () => {
    // An empty picker that says why beats a picker full of ids that 404 — which
    // is exactly what the hand-written list did.
    const catalogue = await readModelCatalogue("codex", () => 1, async () => ({ models: [], message: "codex is not installed" }));
    expect(catalogue).toMatchObject({ models: [], source: "builtin", message: "codex is not installed" });
  });

  test("Codex that answers is marked as coming from the provider", async () => {
    const catalogue = await readModelCatalogue("codex", () => 1, async () => ({
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, hidden: false, efforts: ["low"] }],
    }));
    expect(catalogue.source).toBe("provider");
  });
});
