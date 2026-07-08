// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  agentMetaFromInput,
  capToolInput,
  capToolOutput,
  detectAgentSpawnTool,
  extractToolResultText,
  ParentFlattener,
  TOOL_INPUT_CAP,
  TOOL_OUTPUT_CAP,
} from "./transcript";

describe("capToolInput", () => {
  test("returns the same reference when already under the cap", () => {
    const input = { command: "ls -la" };
    expect(capToolInput(input)).toBe(input);
  });

  test("exactly-at-cap JSON size is left untouched (boundary: > not >=)", () => {
    // Build an input whose JSON.stringify is exactly TOOL_INPUT_CAP chars.
    const overhead = JSON.stringify({ command: "" }).length; // includes the two quotes for value
    const input = { command: "x".repeat(TOOL_INPUT_CAP - overhead) };
    expect(JSON.stringify(input).length).toBe(TOOL_INPUT_CAP);
    expect(capToolInput(input)).toBe(input);
  });

  test("one char over the cap triggers truncation", () => {
    const overhead = JSON.stringify({ command: "" }).length;
    const input = { command: "x".repeat(TOOL_INPUT_CAP - overhead + 1) };
    expect(JSON.stringify(input).length).toBe(TOOL_INPUT_CAP + 1);
    const result = capToolInput(input);
    expect(result).not.toBe(input);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_INPUT_CAP);
    expect(result.command).toContain("… (+");
    expect(result.command).toContain(" chars)");
  });

  test("truncates the largest string field first, leaves small fields intact", () => {
    const input = {
      file_path: "/repo/small.txt",
      content: "y".repeat(6000),
    };
    const result = capToolInput(input);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_INPUT_CAP);
    expect(result.file_path).toBe("/repo/small.txt"); // untouched: it wasn't the offender
    expect(typeof result.content).toBe("string");
    expect(result.content as string).toContain("… (+");
  });

  test("marker reports the number of removed characters, and the head is a real prefix", () => {
    const value = "a".repeat(5000);
    const input = { content: value };
    const result = capToolInput(input);
    const match = /^(a*)… \(\+(\d+) chars\)$/.exec(result.content as string);
    expect(match).not.toBeNull();
    const [, head, removedStr] = match!;
    const removed = Number(removedStr);
    expect(value.startsWith(head)).toBe(true);
    expect(head.length + removed).toBe(value.length);
  });

  test("shrinks multiple oversized string fields, largest first, until it fits", () => {
    const input = {
      a: "1".repeat(3000),
      b: "2".repeat(3000),
    };
    const result = capToolInput(input);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_INPUT_CAP);
  });

  test("non-string fields are left untouched", () => {
    const input = { command: "z".repeat(5000), timeout: 30000, verbose: true };
    const result = capToolInput(input);
    expect(result.timeout).toBe(30000);
    expect(result.verbose).toBe(true);
  });

  test("unicode: truncation does not split a surrogate pair / astral character", () => {
    const emoji = "😀"; // astral, encoded as a surrogate pair in UTF-16
    const input = { content: emoji.repeat(3000) };
    const result = capToolInput(input);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_INPUT_CAP);
    // No lone surrogate: re-encoding to an array of code points and back
    // round-trips without producing replacement/invalid characters.
    const head = (result.content as string).split("… (+")[0];
    expect(Array.from(head).join("")).toBe(head);
  });

  test("respects a custom cap argument", () => {
    // Cap comfortably above the marker's own overhead (~30 chars for this
    // shape) so the request is actually satisfiable.
    const input = { command: "x".repeat(100) };
    const result = capToolInput(input, 50);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(50);
  });

  test("empty object under cap returns as-is", () => {
    const input = {};
    expect(capToolInput(input)).toBe(input);
  });
});

describe("extractToolResultText", () => {
  test("plain string content passes through unchanged", () => {
    expect(extractToolResultText("hello")).toBe("hello");
  });

  test("empty string content passes through unchanged", () => {
    expect(extractToolResultText("")).toBe("");
  });

  test("array of text blocks is concatenated with no separator", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    expect(extractToolResultText(content)).toBe("hello world");
  });

  test("non-text blocks (e.g. images) are dropped, not concatenated as [object Object]", () => {
    const content = [
      { type: "text", text: "see: " },
      { type: "image", source: { type: "base64", data: "..." } },
      { type: "text", text: "above" },
    ];
    expect(extractToolResultText(content)).toBe("see: above");
  });

  test("empty array yields empty string", () => {
    expect(extractToolResultText([])).toBe("");
  });

  test("non-string, non-array content (null/undefined/number) yields empty string", () => {
    expect(extractToolResultText(null)).toBe("");
    expect(extractToolResultText(undefined)).toBe("");
    expect(extractToolResultText(42)).toBe("");
  });

  test("malformed blocks without a text field are skipped", () => {
    const content = [{ type: "text" }, { type: "text", text: "kept" }];
    expect(extractToolResultText(content)).toBe("kept");
  });
});

describe("capToolOutput", () => {
  test("returns the same reference when under the cap", () => {
    const text = "short output";
    expect(capToolOutput(text)).toBe(text);
  });

  test("exactly-at-cap length is left untouched (boundary: > not >=)", () => {
    const text = "x".repeat(TOOL_OUTPUT_CAP);
    expect(capToolOutput(text)).toBe(text);
  });

  test("one char over the cap triggers truncation with a tail marker", () => {
    const text = "x".repeat(TOOL_OUTPUT_CAP + 1);
    const result = capToolOutput(text);
    expect(result).not.toBe(text);
    expect(result).toBe("x".repeat(TOOL_OUTPUT_CAP) + "… (+1 chars)");
  });

  test("keeps exactly the head prefix plus a marker reporting removed count", () => {
    const text = "y".repeat(3000);
    const result = capToolOutput(text);
    expect(result).toBe("y".repeat(TOOL_OUTPUT_CAP) + "… (+500 chars)");
  });

  test("unicode: does not split a surrogate pair at the boundary", () => {
    const overCap = "😀".repeat(TOOL_OUTPUT_CAP + 1); // astral emoji, one surrogate pair each
    const result = capToolOutput(overCap);
    const head = result.split("… (+")[0];
    expect(Array.from(head).length).toBe(TOOL_OUTPUT_CAP);
    expect(Array.from(head).join("")).toBe(head);
  });

  test("respects a custom cap argument", () => {
    expect(capToolOutput("hello world", 5)).toBe("hello… (+6 chars)");
  });

  test("empty string under cap returns as-is", () => {
    expect(capToolOutput("")).toBe("");
  });
});

describe("detectAgentSpawnTool", () => {
  test("finds \"Agent\" when present", () => {
    expect(detectAgentSpawnTool(["Read", "Grep", "Agent", "Bash"])).toBe("Agent");
  });

  test("falls back to the legacy \"Task\" name when \"Agent\" is absent", () => {
    expect(detectAgentSpawnTool(["Read", "Task", "Bash"])).toBe("Task");
  });

  test("prefers \"Agent\" over \"Task\" when both are somehow present", () => {
    expect(detectAgentSpawnTool(["Task", "Agent"])).toBe("Agent");
  });

  test("returns null when neither candidate is in the list", () => {
    expect(detectAgentSpawnTool(["Read", "Grep", "Bash"])).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(detectAgentSpawnTool([])).toBeNull();
  });

  test("returns null when tools is undefined", () => {
    expect(detectAgentSpawnTool(undefined)).toBeNull();
  });
});

describe("agentMetaFromInput", () => {
  test("extracts description, subagent_type, and name", () => {
    const input = {
      description: "Fix the bug",
      prompt: "Go fix it",
      subagent_type: "general-purpose",
      name: "bugfixer",
    };
    expect(agentMetaFromInput(input)).toEqual({
      type: "general-purpose",
      description: "Fix the bug",
      name: "bugfixer",
    });
  });

  test("omits name when absent, rather than setting it to undefined explicitly", () => {
    const result = agentMetaFromInput({ description: "Fix the bug", prompt: "Go" });
    expect(result).toEqual({ type: null, description: "Fix the bug" });
    expect("name" in result).toBe(false);
  });

  test("defaults type to null and description to empty string when missing", () => {
    expect(agentMetaFromInput({})).toEqual({ type: null, description: "" });
  });

  test("ignores non-string fields rather than trusting model-controlled JSON shapes", () => {
    const input = {
      description: 42,
      subagent_type: { nested: true },
      name: ["array"],
    };
    expect(agentMetaFromInput(input as unknown as Record<string, unknown>)).toEqual({
      type: null,
      description: "",
    });
  });
});

describe("ParentFlattener", () => {
  test("resolve(null/undefined) is null (top-level, no parent)", () => {
    const f = new ParentFlattener();
    expect(f.resolve(null)).toBeNull();
    expect(f.resolve(undefined)).toBeNull();
  });

  test("resolve of an unrecorded id falls back to that id unchanged (depth-1 subagent)", () => {
    const f = new ParentFlattener();
    expect(f.resolve("spawn-1")).toBe("spawn-1");
  });

  test("noteSpawn with a null resolvedParent records nothing (top-level spawn is its own resolution)", () => {
    const f = new ParentFlattener();
    f.noteSpawn("spawn-1", null);
    expect(f.resolve("spawn-1")).toBe("spawn-1");
  });

  test("flattens a depth-2 nested spawn to its top-level ancestor", () => {
    const f = new ParentFlattener();
    // Top-level spawn "spawn-1" (no ancestor to record). Inside it, the
    // subagent itself calls the spawn tool again, creating nested spawn
    // "spawn-2" — recorded under spawn-1, the parent resolved for the
    // message that contained it.
    f.noteSpawn("spawn-2", f.resolve("spawn-1"));
    expect(f.resolve("spawn-2")).toBe("spawn-1");
  });

  test("flattens arbitrarily deep nesting (depth-3) to the single top-level ancestor", () => {
    const f = new ParentFlattener();
    f.noteSpawn("spawn-2", f.resolve("spawn-1"));
    f.noteSpawn("spawn-3", f.resolve("spawn-2"));
    expect(f.resolve("spawn-3")).toBe("spawn-1");
    // Messages directly under spawn-2 still flatten to the same ancestor.
    expect(f.resolve("spawn-2")).toBe("spawn-1");
  });

  test("independent spawn trees do not cross-contaminate", () => {
    const f = new ParentFlattener();
    f.noteSpawn("a2", f.resolve("a1"));
    f.noteSpawn("b2", f.resolve("b1"));
    expect(f.resolve("a2")).toBe("a1");
    expect(f.resolve("b2")).toBe("b1");
    expect(f.resolve("a1")).toBe("a1");
    expect(f.resolve("b1")).toBe("b1");
  });
});
