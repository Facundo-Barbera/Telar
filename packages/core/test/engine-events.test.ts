import { describe, expect, test, mock } from "bun:test";
import { z } from "zod";

// Mock the Claude Agent SDK so agent() runs its real event loop against a
// synthetic message stream — no live model call. We only exercise onEvent
// shaping (tool input + best-effort tool-result capture), so emit_result is
// never invoked and agent() returns null; that's fine here.
function mockSdk(messages: unknown[]) {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    tool: (_n: string, _d: string, _s: unknown, _h: unknown) => ({}),
    createSdkMcpServer: (cfg: unknown) => cfg,
    query: () =>
      (async function* () {
        for (const m of messages) yield m;
      })(),
  }));
}

describe("engine onEvent shaping", () => {
  test("a tool event carries the block's input; tool-result is captured", async () => {
    mockSdk([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la", timeout: 5000 } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "a\nb\nc" }],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: 2 },
    ]);

    // Import after the mock is registered so engine binds the stubbed SDK.
    const { agent } = await import("../src/engine");

    const events: any[] = [];
    await agent("hi", {
      schema: z.object({ ok: z.boolean() }),
      onEvent: (e) => events.push(e),
    });

    const tool = events.find((e) => e.type === "tool");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("Bash");
    expect(tool.input).toEqual({ command: "ls -la", timeout: 5000 });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult.name).toBe("Bash"); // labelled via tool_use_id -> name map
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe("a\nb\nc");
  });

  test("large tool-result output is truncated to the 4KB cap", async () => {
    const big = "x".repeat(10_000);
    mockSdk([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_9", name: "Read", input: { file: "big" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_9", content: big }] },
      },
    ]);

    const { agent } = await import("../src/engine");
    const events: any[] = [];
    await agent("hi", { schema: z.object({ ok: z.boolean() }), onEvent: (e) => events.push(e) });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult.output.length).toBeLessThan(10_000);
    expect(toolResult.output.endsWith("…[truncated]")).toBe(true);
  });

  test("a huge tool_use input string value is truncated but structure is preserved", async () => {
    const big = "x".repeat(20_000);
    mockSdk([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_2",
              name: "Write",
              input: { file_path: "/a/b.ts", content: big },
            },
          ],
        },
      },
    ]);

    const { agent } = await import("../src/engine");
    const events: any[] = [];
    await agent("hi", { schema: z.object({ ok: z.boolean() }), onEvent: (e) => events.push(e) });

    const tool = events.find((e) => e.type === "tool");
    expect(tool).toBeDefined();
    // Structure preserved: preview keys still resolve.
    expect(tool.input.file_path).toBe("/a/b.ts");
    // Oversized string value capped in place.
    expect(tool.input.content.length).toBeLessThan(20_000);
    expect(tool.input.content.endsWith("…[truncated]")).toBe(true);
  });
});
