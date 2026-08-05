// The port's own proof. Two things are worth pinning here and nothing else is:
// that the event vocabulary is ENUMERABLE (so a conformance suite can assert
// an adapter covers it, rather than asserting the subset that adapter already
// emits), and that the capability gate REFUSES rather than degrades.
//
// The second is not hypothetical. A Codex session was asked to run an Ultra,
// nothing consulted the capability list, the ultra tool was never in its
// toolset, and instead of an error the user got a model narrating three
// sub-agents it had not spawned. `unmetRequirement` is the function that turns
// that into a refusal.
import { describe, expect, test } from "bun:test";
import {
  HARNESS_EVENT_TYPES,
  HarnessEvent,
  unmetRequirement,
  type HarnessToolNamespace,
} from "../src/harness-port";
import { PROVIDERS } from "../src/providers";

describe("the event vocabulary", () => {
  test("every variant is enumerable, and the list matches the union", () => {
    // If a variant is added to the union without appearing here, this fails —
    // which is the point: the enumeration is what a conformance suite iterates.
    expect([...HARNESS_EVENT_TYPES].sort()).toEqual(
      [
        "error",
        "rate_limits",
        "session",
        "spawn",
        "spawn_result",
        "text",
        "text_delta",
        "thinking_delta",
        "thinking_start",
        "tool",
        "tool_result",
        "usage",
      ].sort(),
    );
  });

  test("a root-thread event omits threadId; a subagent event carries it", () => {
    // The asymmetry is load-bearing — it is what lets a surface that knows
    // nothing about subagents render the common case unchanged.
    expect(HarnessEvent.parse({ type: "text", itemId: "i1", text: "hi" }).type).toBe("text");
    const sub = HarnessEvent.parse({ type: "text", itemId: "i1", text: "hi", threadId: "t2" });
    expect(sub).toMatchObject({ threadId: "t2" });
  });

  test("session is the one event with no thread attribution at all", () => {
    const e = HarnessEvent.parse({ type: "session", sessionId: "s1" });
    expect(e).toEqual({ type: "session", sessionId: "s1" });
  });

  test("spawn and spawn_result expose an explicit start then terminal lifecycle", () => {
    const started = HarnessEvent.parse({
      type: "spawn",
      parentThreadId: "root",
      childThreadId: "child",
      prompt: "inspect the adapter",
      model: "gpt-5",
    });
    expect(started).toMatchObject({ type: "spawn", childThreadId: "child" });

    for (const status of ["completed", "failed", "stopped"] as const) {
      const terminal = HarnessEvent.parse({
        type: "spawn_result",
        childThreadId: "child",
        output: status,
        isError: status !== "completed",
        status,
      });
      expect(terminal).toMatchObject({ status });
    }
  });

  test("spawn_result refuses a provider-specific or missing terminal status", () => {
    const base = {
      type: "spawn_result",
      childThreadId: "child",
      output: "",
      isError: true,
    } as const;
    expect(HarnessEvent.safeParse(base).success).toBe(false);
    expect(HarnessEvent.safeParse({ ...base, status: "errored" }).success).toBe(false);
  });

  test("rate_limits relays raw windows, nulls included", () => {
    const e = HarnessEvent.parse({
      type: "rate_limits",
      primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: null },
      secondary: null,
      planType: null,
    });
    expect(e).toMatchObject({ secondary: null, planType: null });
  });

  test("an unknown type is rejected rather than passed through", () => {
    expect(HarnessEvent.safeParse({ type: "vibes", text: "x" }).success).toBe(false);
  });
});

describe("the capability gate", () => {
  const ns = (name: string): HarnessToolNamespace => ({ name, version: "1.0.0", tools: [] });

  test("a harness without mcp-servers is REFUSED tools, not quietly stripped", () => {
    const port = { capabilities: ["interactive-approval"] as const };
    expect(unmetRequirement(port, { tools: [ns("ultra")] })).toBe("mcp-servers");
  });

  test("a harness without system-prompt-append is REFUSED instructions", () => {
    const port = { capabilities: ["mcp-servers"] as const };
    expect(unmetRequirement(port, { instructions: "be careful" })).toBe("system-prompt-append");
  });

  test("whitespace-only instructions are not a requirement", () => {
    // Otherwise every turn on a harness lacking the capability would fail on an
    // appendix that says nothing.
    const port = { capabilities: [] as const };
    expect(unmetRequirement(port, { instructions: "   \n" })).toBeNull();
    expect(unmetRequirement(port, { instructions: "" })).toBeNull();
  });

  test("an empty tool list is not a requirement either", () => {
    const port = { capabilities: [] as const };
    expect(unmetRequirement(port, { tools: [] })).toBeNull();
  });

  test("a request asking for nothing passes on a harness publishing nothing", () => {
    expect(unmetRequirement({ capabilities: [] as const }, {})).toBeNull();
  });

  test("tools are reported before instructions when BOTH are unmet", () => {
    // Deterministic ordering matters for the error message the user reads.
    const port = { capabilities: [] as const };
    expect(unmetRequirement(port, { tools: [ns("ultra")], instructions: "x" })).toBe("mcp-servers");
  });
});

// The gate is only as honest as the capability lists it reads, so these tie it
// to the real descriptors rather than to hand-written fixtures.
describe("against the real providers", () => {
  test("Claude admits tools and instructions", () => {
    expect(unmetRequirement(PROVIDERS.claude, { tools: [], instructions: "x" })).toBeNull();
    expect(
      unmetRequirement(PROVIDERS.claude, {
        tools: [{ name: "ultra", version: "1.0.0", tools: [] }],
      }),
    ).toBeNull();
  });

  test("whatever Codex publishes, the gate agrees with it", () => {
    // Deliberately not asserting a fixed answer: this file must keep passing
    // across the very change that grants Codex these capabilities. What it
    // pins is that the GATE and the DESCRIPTOR cannot disagree.
    const wantsTools = { tools: [{ name: "ultra", version: "1.0.0", tools: [] }] };
    const publishes = PROVIDERS.codex.capabilities.includes("mcp-servers");
    expect(unmetRequirement(PROVIDERS.codex, wantsTools) === null).toBe(publishes);
  });
});
