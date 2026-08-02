// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { extractCodexEntries, fetchModels } from "@/lib/model-registry";
import { contextLabelForModel } from "@/lib/models";

describe("harness-owned model catalogs", () => {
  test("Claude exposes native slots even when a gateway URL is inherited", async () => {
    const models = await fetchModels("claude", {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "unused",
    });
    expect(models.map((model) => model.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
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
