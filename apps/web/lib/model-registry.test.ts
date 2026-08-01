// The proof for the gateway's two model-id disguises, and the interaction
// between them that broke pinning.
//
// CLIProxyAPI applies BOTH at once when a client identifies as Anthropic:
//   · CLOAKING — a foreign id is served as `claude-fable-5-dd-<id reversed>`,
//     because Claude Code rejects model ids that don't look like its own.
//   · PREFIXING — a pinned credential's models are additionally registered as
//     `<prefix>/<model>`.
// A pinned Claude model therefore arrives as the reversal of `work/claude-…`,
// which is neither a recognisable harness name nor a string starting with the
// prefix. Both facts were measured against a live gateway (7.2.110).
//
// NO NETWORK: every function here is pure, which is why they were factored out
// of the fetch.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { decloakModelId, narrowToPrefix } from "@/lib/model-registry";
import type { ModelInfo } from "@/lib/models";

// Real ids, transcribed from the live catalog.
const CLOAKED_GPT = "claude-fable-5-dd-anul-6.5-tpg"; // gpt-5.6-luna
const CLOAKED_PINNED = "claude-fable-5-dd-22014202-ukiah-5-3-edualc/krow"; // work/claude-3-5-haiku-20241022

const model = (id: string, name = id): ModelInfo => ({
  id,
  name,
  tier: "sonnet",
  context: "—",
  maxOutput: "—",
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  blurb: "",
});

describe("decloakModelId", () => {
  test("decodes a cloaked foreign model", () => {
    expect(decloakModelId(CLOAKED_GPT)).toBe("gpt-5.6-luna");
  });

  test("decodes a cloaked PINNED model — the case that broke pinning", () => {
    // An earlier guard only accepted decodes starting with a known harness
    // name, so `work/claude-…` was rejected and pinning silently did nothing.
    expect(decloakModelId(CLOAKED_PINNED)).toBe("work/claude-3-5-haiku-20241022");
  });

  test("leaves an uncloaked id alone", () => {
    expect(decloakModelId("claude-opus-4-6")).toBeNull();
    expect(decloakModelId("gpt-5.4")).toBeNull();
  });

  test("refuses to decode into something that isn't id-shaped", () => {
    expect(decloakModelId("claude-fable-5-dd- has spaces ")).toBeNull();
  });
});

describe("narrowToPrefix", () => {
  test("keeps only the pinned credential's models, seen through the cloak", () => {
    const catalog = [
      model("claude-opus-4-6"), // pooled — any login may serve it
      model(CLOAKED_PINNED, "Claude 3.5 Haiku"), // pinned to work/
      model(CLOAKED_GPT, "GPT 5.6 Luna"), // pooled, foreign
    ];
    const mine = narrowToPrefix(catalog, "work");
    expect(mine).toHaveLength(1);
    // The WIRE id stays cloaked — that is what the gateway advertised and
    // expects back. Rewriting it would name a model the proxy never heard of.
    expect(mine[0].id).toBe(CLOAKED_PINNED);
    expect(mine[0].name).toBe("Claude 3.5 Haiku");
  });

  test("no duplicate names survive — the pooled twin is dropped", () => {
    // The gateway registers each model twice, bare and prefixed, under the same
    // display name. Unnarrowed, the picker showed both and neither said which
    // login it would use.
    const catalog = [model(CLOAKED_PINNED, "Claude 3.5 Haiku"), model("claude-3-5-haiku-20241022", "Claude 3.5 Haiku")];
    const names = narrowToPrefix(catalog, "work").map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a prefix that matches nothing falls back to the whole catalog", () => {
    // Not set on the gateway, or misspelled. An empty picker would be worse
    // than behaving like an unpinned account until it is fixed.
    const catalog = [model("claude-opus-4-6"), model(CLOAKED_GPT)];
    expect(narrowToPrefix(catalog, "nonexistent")).toHaveLength(2);
  });

  test("works on plain, uncloaked prefixed ids too (non-Anthropic clients)", () => {
    const catalog = [model("work/claude-opus-4-6"), model("claude-opus-4-6")];
    const mine = narrowToPrefix(catalog, "work");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("work/claude-opus-4-6");
  });
});
