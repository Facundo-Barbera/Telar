// Cut U4-A — the REAL agent runner (docs/plans/ultra-harness.md §3/§4).
// The Claude Agent SDK is MOCKED at the module boundary (mock.module, the
// engine-events.test.ts / loom-mcp test convention) — no live SDK call, no
// spend. Exercises: schema present -> forced emit_result (structured
// result); schema absent -> final-text capture (doc §3's other half); the
// fixed child posture (tools always restricted, no per-agent knob); no
// model default, ever; onEvent narration (text/tool/tool-result/result) and
// cost/turns surfacing.
import { describe, expect, test, mock } from "bun:test";
import { z } from "zod";

type SdkMsg = Record<string, unknown>;

// Captures the `options` object query() was called with, so a test can
// assert the fixed child posture (tools/allowedTools/permissionMode) without
// needing a real session.
function mockSdk(messages: SdkMsg[]): { capturedOptions: any[] } {
  const capturedOptions: any[] = [];
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    tool: (name: string, _d: string, _shape: unknown, handler: unknown) => ({ name, handler }),
    createSdkMcpServer: (cfg: { tools: Array<{ name: string; handler: (v: unknown) => unknown }> }) => cfg,
    query: (req: { options: any }) => {
      capturedOptions.push(req.options);
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
  }));
  return { capturedOptions };
}

const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const resultMsg = (costUsd: number, turns: number) => ({
  type: "result",
  subtype: "success",
  total_cost_usd: costUsd,
  num_turns: turns,
});

describe("Ultra runner — no default model, ever", () => {
  test("a call with an empty model throws MissingModel without ever calling query()", async () => {
    const { capturedOptions } = mockSdk([]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    await expect(runUltraAgent("hi", { model: "" })).rejects.toThrow(/model/i);
    expect(capturedOptions.length).toBe(0);
  });
});

describe("Ultra runner — schema present forces a validated emit_result call", () => {
  test("emit_result's recorded value is the returned result; the prompt is annotated to call it", async () => {
    const schema = z.object({ ok: z.boolean() });
    let capturedPrompt = "";
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      tool: (name: string, _d: string, _shape: unknown, handler: (v: unknown) => unknown) => ({ name, handler }),
      createSdkMcpServer: (cfg: { tools: Array<{ name: string; handler: (v: unknown) => unknown }> }) => cfg,
      query: (req: { prompt: string; options: any }) => {
        capturedPrompt = req.prompt;
        return (async function* () {
          // Simulate the model calling emit_result by directly invoking the
          // registered tool handler through the mcpServers config we were given.
          const out = req.options.mcpServers.out as { tools: Array<{ name: string; handler: (v: unknown) => unknown }> };
          const emit = out.tools.find((t) => t.name === "emit_result")!;
          await emit.handler({ ok: true });
          yield resultMsg(0.02, 3);
        })();
      },
    }));
    const { runUltraAgent } = await import("../src/ultra/runner");
    const result = await runUltraAgent("do the thing", { model: "sonnet", schema });
    expect(result).toEqual({ ok: true });
    expect(capturedPrompt).toContain("emit_result");
  });

  test("mcpServers/allowedTools include the out server + emit_result only when a schema is given", async () => {
    const { capturedOptions } = mockSdk([resultMsg(0, 1)]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    await runUltraAgent("p", { model: "sonnet", schema: z.object({ ok: z.boolean() }) });
    const opts = capturedOptions[0];
    expect(opts.allowedTools).toContain("mcp__out__emit_result");
    expect(opts.mcpServers.out).toBeDefined();
  });
});

describe("Ultra runner — schema absent captures the final assistant text (doc §3)", () => {
  test("no tool is forced; the LAST text block is returned verbatim", async () => {
    const { capturedOptions } = mockSdk([assistantText("first draft"), assistantText("final answer")]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    const result = await runUltraAgent("summarize", { model: "sonnet" });
    expect(result).toBe("final answer");
    const opts = capturedOptions[0];
    expect(opts.mcpServers.out).toBeUndefined();
    expect(opts.allowedTools).not.toContain("mcp__out__emit_result");
  });

  test("a model that never emits any text resolves to null, never inferred", async () => {
    mockSdk([{ type: "result", subtype: "success" }]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    const result = await runUltraAgent("p", { model: "sonnet" });
    expect(result).toBeNull();
  });
});

describe("Ultra runner — fixed child posture (doc §3: no per-agent permission knob)", () => {
  test("tools are ALWAYS restricted to the normal session surface, permissionMode is bypassPermissions (non-interactive)", async () => {
    const { capturedOptions } = mockSdk([resultMsg(0, 1)]);
    const { runUltraAgent, ULTRA_CHILD_TOOLS } = await import("../src/ultra/runner");
    await runUltraAgent("p", { model: "sonnet", schema: z.object({ ok: z.boolean() }) });
    const opts = capturedOptions[0];
    expect(opts.tools).toEqual([...ULTRA_CHILD_TOOLS]);
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.strictMcpConfig).toBe(true);
  });

  test("the model is passed through verbatim — no fallback to a default model", async () => {
    const { capturedOptions } = mockSdk([resultMsg(0, 1)]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    await runUltraAgent("p", { model: "opus", schema: z.object({ ok: z.boolean() }) });
    expect(capturedOptions[0].model).toBe("opus");
  });

  test("cwd defaults to process.cwd() when opts.cwd is omitted; honors an explicit cwd (project root / isolation worktree, doc §3)", async () => {
    const { capturedOptions } = mockSdk([resultMsg(0, 1)]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    await runUltraAgent("p", { model: "sonnet", schema: z.object({ ok: z.boolean() }) });
    expect(capturedOptions[0].cwd).toBe(process.cwd());

    await runUltraAgent("p", { model: "sonnet", schema: z.object({ ok: z.boolean() }), cwd: "/tmp/some-worktree" });
    expect(capturedOptions[1].cwd).toBe("/tmp/some-worktree");
  });

  test("an AbortController is forwarded as abortController when given", async () => {
    const { capturedOptions } = mockSdk([resultMsg(0, 1)]);
    const { runUltraAgent } = await import("../src/ultra/runner");
    const abort = new AbortController();
    await runUltraAgent("p", { model: "sonnet", schema: z.object({ ok: z.boolean() }), abort });
    expect(capturedOptions[0].abortController).toBe(abort);
  });
});

describe("Ultra runner — onEvent narration + cost/turns (doc §3 cost visibility)", () => {
  test("text/tool/tool-result/result all surface on onEvent, result carries costUsd/turns", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      tool: (name: string, _d: string, _shape: unknown, handler: (v: unknown) => unknown) => ({ name, handler }),
      createSdkMcpServer: (cfg: unknown) => cfg,
      query: () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess_1" };
          yield {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "working" },
                { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
              ],
            },
          };
          yield {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "a b c" }] },
          };
          yield resultMsg(0.05, 4);
        })(),
    }));
    const { runUltraAgent } = await import("../src/ultra/runner");
    const events: any[] = [];
    await runUltraAgent("p", { model: "sonnet", onEvent: (e) => events.push(e) });

    expect(events.find((e) => e.type === "session")?.sessionId).toBe("sess_1");
    expect(events.find((e) => e.type === "text")?.text).toBe("working");
    const toolEv = events.find((e) => e.type === "tool");
    expect(toolEv.name).toBe("Bash");
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult.name).toBe("Bash");
    expect(toolResult.ok).toBe(true);
    const resultEv = events.find((e) => e.type === "result");
    expect(resultEv.costUsd).toBe(0.05);
    expect(resultEv.turns).toBe(4);
  });
});

describe("Ultra runner — schema'd calls join engine.ts's shared MAX_CONCURRENT gate (doc §3)", () => {
  // engine.ts's gate (MAX_CONCURRENT=4, engine.ts:89-99) is module-private —
  // only ever entered from inside engine.agent()'s own acquire()/release()
  // wrapper. runUltraAgent's schema'd path now delegates to engine.agent()
  // (runner.ts file header), so a burst bigger than the process ceiling must
  // never exceed 4 concurrent live query() sessions, even though this
  // runner's own per-call code has no semaphore of its own.
  test("6 concurrent schema'd calls never exceed 4 in-flight query() sessions at once", async () => {
    let inFlight = 0;
    let peak = 0;
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      tool: (name: string, _d: string, _shape: unknown, handler: (v: unknown) => unknown) => ({ name, handler }),
      createSdkMcpServer: (cfg: { tools: Array<{ name: string; handler: (v: unknown) => unknown }> }) => cfg,
      query: (req: { options: any }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return (async function* () {
          // A real (short) delay, not a manually-released promise, so batch 2
          // (the calls that had to wait) genuinely only starts once batch 1
          // has released its slots — proving the CAP, not scheduling luck.
          await new Promise((r) => setTimeout(r, 15));
          const out = req.options.mcpServers.out as {
            tools: Array<{ name: string; handler: (v: unknown) => unknown }>;
          };
          await out.tools.find((t) => t.name === "emit_result")!.handler({ ok: true });
          inFlight--;
          yield resultMsg(0, 1);
        })();
      },
    }));
    const { runUltraAgent } = await import("../src/ultra/runner");
    const schema = z.object({ ok: z.boolean() });
    const N = 6; // > MAX_CONCURRENT=4, so the cap is actually exercised
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runUltraAgent(`p${i}`, { model: "sonnet", schema })),
    );
    expect(results).toEqual(Array(N).fill({ ok: true }));
    expect(peak).toBe(4); // engine.ts's MAX_CONCURRENT (engine.ts:89) — never more
  });
});
