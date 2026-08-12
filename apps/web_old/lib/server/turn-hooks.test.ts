// THE SPAWN STRIP, PINNED (#28 adjacent). A model-supplied `mode` or
// `isolation` on an Agent/Task spawn must never reach the SDK (bypass and
// off-box execution are host decisions), while `run_in_background` must pass
// through untouched — backgrounded agents are safe under the persistent
// session runtime (lib/server/session-runtime.ts), and an interim fix that
// forced them synchronous here has been deliberately reverted. These tests
// pin both directions so neither regresses silently.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import type { SessionProfile } from "@telar/core";
import { makePreToolUseGuardrail } from "./turn-hooks";

const profile = {
  cwd: "/tmp/turn-hooks-test",
  guardrails: { disallowedTools: ["WebFetch"], protectedPaths: [] },
} as unknown as SessionProfile;

function preToolUse(tool_name: string, tool_input: Record<string, unknown>) {
  return makePreToolUseGuardrail(profile)({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    // The remaining HookInput fields are not read by the guardrail.
  } as never);
}

function updatedInputOf(out: unknown): Record<string, unknown> | undefined {
  return (out as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } })
    .hookSpecificOutput?.updatedInput;
}

describe("PreToolUse spawn strip", () => {
  test("a clean spawn input passes through with no rewrite at all", async () => {
    const out = await preToolUse("Agent", { prompt: "explore", description: "x" });
    expect(updatedInputOf(out)).toBeUndefined();
    expect((out as { continue?: boolean }).continue).toBe(true);
  });

  test("run_in_background is the model's to choose — no rewrite fires for it", async () => {
    const out = await preToolUse("Task", { prompt: "p", run_in_background: true });
    expect(updatedInputOf(out)).toBeUndefined();
  });

  test("mode and isolation are stripped; run_in_background survives the strip", async () => {
    const out = await preToolUse("Agent", {
      prompt: "p",
      mode: "bypassPermissions",
      isolation: "remote",
      run_in_background: true,
    });
    expect(updatedInputOf(out)).toEqual({ prompt: "p", run_in_background: true });
  });

  test("non-spawn tools pass through untouched", async () => {
    const out = await preToolUse("Read", { file_path: "/x" });
    expect(updatedInputOf(out)).toBeUndefined();
    expect((out as { continue?: boolean }).continue).toBe(true);
  });

  test("a guardrail deny still wins over the spawn strip", async () => {
    const out = await preToolUse("WebFetch", {
      url: "https://example.com",
      mode: "bypassPermissions",
    });
    const hso = (out as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput;
    expect(hso?.permissionDecision).toBe("deny");
  });
});
