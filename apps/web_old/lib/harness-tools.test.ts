// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HarnessToolNamespace } from "@telar/core";
import { CODEX_BROWSER_TOOL_NAMESPACE } from "./browser-mcp";
import { toContentItems, toDynamicTools } from "./harness-tools";

describe("Codex dynamic tool protocol", () => {
  test("uses the canonical discriminator at the namespace and tool levels", () => {
    const namespace: HarnessToolNamespace = {
      name: "workspace",
      version: "test",
      tools: [
        {
          name: "list_items",
          description: "List items.",
          inputSchema: { lane: z.string().optional() },
          handler: async () => ({ content: [{ type: "text", text: "[]" }] }),
        },
      ],
    };

    const [spec] = toDynamicTools([namespace]);
    expect(spec?.type).toBe("namespace");
    if (!spec || spec.type !== "namespace") throw new Error("expected namespace tool spec");
    expect(spec.tools[0]?.type).toBe("function");
    expect(spec.tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  test("recognizes the current app-server callback method", () => {
    const adapter = readFileSync(new URL("./codex-app-server.ts", import.meta.url), "utf8");
    expect(adapter).toContain('"item/tool/call"');
  });

  test("passes browser screenshots to Codex as input images", () => {
    expect(toContentItems({
      content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
    })).toEqual([
      { type: "inputImage", imageUrl: "data:image/png;base64,cG5n" },
    ]);
  });

  test("uses a Telar-qualified browser namespace that does not collide with Responses", () => {
    expect(CODEX_BROWSER_TOOL_NAMESPACE).toBe("telar_browser");
    expect(CODEX_BROWSER_TOOL_NAMESPACE).not.toBe("browser");
  });
});
