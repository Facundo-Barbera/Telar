/**
 * Routing ids, read for the picker. Pinned against what `opencode models`
 * actually answers on this machine (2026-09-10): the same model on two
 * connections, ids that must never be rewritten, and models.dev's own
 * connection names.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { connectionLabel, familySearchText, routeOf, routedModelLabel } from "./model-connections";
import { groupFamilies } from "./model-families";
import type { ProviderModel } from "@telar/engine-client";

const row = (id: string): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  source: "provider",
  efforts: [],
  fastMode: false,
});

describe("routeOf", () => {
  test("splits an OpenCode routing id and leaves bare ids alone", () => {
    expect(routeOf("openai/gpt-5.6-luna")).toEqual({ connection: "openai", model: "gpt-5.6-luna" });
    expect(routeOf("amazon-bedrock/anthropic.claude-fable-5")).toEqual({ connection: "amazon-bedrock", model: "anthropic.claude-fable-5" });
    // Claude Code and Codex ids are not routes.
    expect(routeOf("sonnet")).toBeNull();
    expect(routeOf("gpt-6-astra")).toBeNull();
    expect(routeOf("/broken")).toBeNull();
    expect(routeOf("broken/")).toBeNull();
  });
});

describe("connectionLabel", () => {
  test("models.dev's own names for the connections on this machine", () => {
    expect(connectionLabel("openai")).toBe("OpenAI");
    expect(connectionLabel("opencode")).toBe("OpenCode Zen");
    expect(connectionLabel("opencode-go")).toBe("OpenCode Go");
    expect(connectionLabel("amazon-bedrock")).toBe("Amazon Bedrock");
  });

  test("an unknown connection is title-cased, never hidden", () => {
    expect(connectionLabel("bedrock-mantle")).toBe("Bedrock Mantle");
    expect(connectionLabel("some_new_gateway")).toBe("Some New Gateway");
  });
});

describe("the duplicate-model, different-connection case", () => {
  test("two routes to one model stay two distinct, distinguishable families", () => {
    // Both are really in the catalogue: gpt-5.6-luna direct and through Go.
    const families = groupFamilies([row("openai/gpt-5.6-luna"), row("opencode-go/gpt-5.6-luna")]);
    expect(families).toHaveLength(2);
    const [direct, go] = families;
    // Same readable model name…
    expect(routedModelLabel(routeOf(direct!.id)!.model)).toBe("GPT-5.6 Luna");
    expect(routedModelLabel(routeOf(go!.id)!.model)).toBe("GPT-5.6 Luna");
    // …distinguished by connection, with the actual routing id preserved.
    expect(connectionLabel(routeOf(direct!.id)!.connection)).toBe("OpenAI");
    expect(connectionLabel(routeOf(go!.id)!.connection)).toBe("OpenCode Go");
    expect(direct!.rows[0]!.id).toBe("openai/gpt-5.6-luna");
    expect(go!.rows[0]!.id).toBe("opencode-go/gpt-5.6-luna");
  });
});

describe("familySearchText", () => {
  test("matches by name, by raw routing id, and by connection", () => {
    const [family] = groupFamilies([row("opencode-go/gpt-5.6-luna")]);
    const text = familySearchText(family!);
    expect(text).toContain("opencode-go/gpt-5.6-luna"); // the pasteable id
    expect(text).toContain("opencode go"); // the connection's display name
    for (const query of ["luna", "go", "opencode go", "gpt-5.6"]) {
      expect(text.includes(query)).toBe(true);
    }
  });

  test("a bare Codex id searches by its label and id only", () => {
    const [family] = groupFamilies([{ ...row("gpt-6-astra"), label: "GPT-6-Astra" }]);
    const text = familySearchText(family!);
    expect(text).toContain("gpt-6-astra");
    expect(text).not.toContain("openai"); // no route, no connection words
  });
});

describe("routedModelLabel", () => {
  test("prettifies the model half the way models.dev spells it", () => {
    expect(routedModelLabel("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(routedModelLabel("glm-5.3-flash")).toBe("GLM-5.3 Flash");
    expect(routedModelLabel("big-pickle")).toBe("Big Pickle");
    expect(routedModelLabel("kimi-k3")).toBe("Kimi K3");
  });
});
