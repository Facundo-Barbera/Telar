// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HarnessToolNamespace } from "@telar/core";
import { toDynamicTools } from "./harness-tools";

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
});
