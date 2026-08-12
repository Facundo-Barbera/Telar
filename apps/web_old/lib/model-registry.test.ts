// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { extractCodexEntries, mapClaudeModels } from "@/lib/model-registry";
import { contextLabelForModel } from "@/lib/models";

describe("harness-owned model catalogs", () => {
  test("Claude exposes resolved harness models instead of a transport inventory", () => {
    const models = mapClaudeModels([
      {
        value: "default",
        resolvedModel: "claude-opus-4-8[1m]",
        displayName: "Default (recommended)",
        description: "Use the default model (currently Opus 4.8)",
      },
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-4-8[1m]",
        displayName: "Opus",
        description: "Opus 4.8 with 1M context",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsFastMode: true,
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Sonnet 5",
      },
    ]);
    expect(models.map((model) => model.id)).toEqual(["opus[1m]", "sonnet", "opus"]);
    expect(models.map((model) => model.name)).toEqual([
      "Claude Opus 4.8",
      "Claude Sonnet 5",
      "Claude Opus 4.8",
    ]);
    expect(models.find((model) => model.id === "opus[1m]")?.isDefault).toBe(true);
    expect(models.find((model) => model.id === "opus[1m]")?.supportsFastMode).toBe(true);
    expect(models.some((model) => model.id.startsWith("gpt"))).toBe(false);
  });

  test("Codex cache layouts are parsed without proxy-specific model rewriting", () => {
    expect(extractCodexEntries(["gpt-a", { slug: "gpt-b" }])).toEqual([
      { slug: "gpt-a" },
      { slug: "gpt-b" },
    ]);
    expect(extractCodexEntries({ models: [{ slug: "gpt-c" }] })).toEqual([
      { slug: "gpt-c" },
    ]);
    expect(extractCodexEntries({ "gpt-d": { display_name: "D" } })).toEqual([
      { slug: "gpt-d", display_name: "D" },
    ]);
  });
});

describe("context metadata", () => {
  test("a persisted concrete Claude id keeps the slot context window", () => {
    expect(contextLabelForModel("claude-sonnet-5", "claude")).toBe("1M");
    expect(contextLabelForModel("claude-haiku-4-5-20251001", "claude")).toBe("200K");
  });

  test("unknown Codex ids do not inherit a fabricated context window", () => {
    expect(contextLabelForModel("gpt-future", "codex")).toBeUndefined();
  });
});
