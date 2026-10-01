import { expect, test, describe } from "bun:test";
import { qualifyTelarTool, requiresHuman } from "@telar/engine-client";
import { itemDetailForToolCall, pathFromPartialInput, requestKindForTool, titleForToolCall } from "./mapping";

describe("pathFromPartialInput", () => {
  test("reads a path whose closing quote has arrived", () => {
    expect(pathFromPartialInput('{"file_path": "/a/b c.ts", "content": "unfin')).toBe("/a/b c.ts");
    expect(pathFromPartialInput('{"notebook_path":"/n.ipynb"')).toBe("/n.ipynb");
    expect(pathFromPartialInput('{"file_path":"C:\\\\x\\"y.ts"')).toBe('C:\\x"y.ts');
  });

  test("claims nothing from a path still arriving, or a key quoted inside a string", () => {
    expect(pathFromPartialInput('{"file_path":"/a/b')).toBeUndefined();
    expect(pathFromPartialInput('{"content":"see \\"path\\": \\"/etc\\"')).toBeUndefined();
    expect(pathFromPartialInput("")).toBeUndefined();
  });
});

test("tool mapping is by CAPABILITY, so a new provider tool is unstyled and never invisible", () => {
  expect(itemDetailForToolCall("Bash", { command: "ls" }).type).toBe("command_execution");
  expect(itemDetailForToolCall("Read", { file_path: "/a" }).type).toBe("file_read");
  expect(itemDetailForToolCall("Write", { file_path: "/a" }).type).toBe("file_change");
  expect(itemDetailForToolCall("Edit", { file_path: "/a" }).type).toBe("file_change");
  expect(itemDetailForToolCall("WebSearch", { query: "q" }).type).toBe("web_search");
  expect(itemDetailForToolCall("mcp__linear__search", {}).type).toBe("mcp_tool_call");
  expect(itemDetailForToolCall("SomeFutureTool", { x: 1 }).type).toBe("dynamic_tool_call");
});

test("an mcp tool carries its server so a client can group by it", () => {
  const detail = itemDetailForToolCall("mcp__linear__search", { q: "x" });
  expect(detail.type === "mcp_tool_call" && detail.call.server).toBe("linear");
});

test("collapsed labels are derived once, by the engine", () => {
  expect(titleForToolCall("Bash", itemDetailForToolCall("Bash", { command: "  ls   -la  " }))).toBe("ls -la");
  expect(titleForToolCall("Read", itemDetailForToolCall("Read", { file_path: "src/a.ts" }))).toBe("src/a.ts");
  expect(titleForToolCall("Odd", itemDetailForToolCall("Odd", {}))).toBe("Odd");
});

describe("Telar's own reads are reads", () => {
  test("a read-shaped core tool is a file_read, so the front door does not park on it", () => {
    expect(requestKindForTool(qualifyTelarTool("display_open"))).toBe("file_read");
    expect(requiresHuman("approval-required", requestKindForTool(qualifyTelarTool("display_open")))).toBe(false);
    expect(requestKindForTool(qualifyTelarTool("display_inline"))).toBe("file_read");
  });

  test("everything that writes or spends still parks, in every attended mode", () => {
    for (const tool of ["sessions_create", "sessions_send", "notes_write"]) {
      expect(requestKindForTool(qualifyTelarTool(tool))).toBe("tool_call");
      expect(requiresHuman("approval-required", requestKindForTool(qualifyTelarTool(tool)))).toBe(true);
      expect(requiresHuman("auto-accept-edits", requestKindForTool(qualifyTelarTool(tool)))).toBe(true);
    }
  });

  test("a stranger's server cannot inherit the engine's posture by naming a tool the same", () => {
    expect(requestKindForTool("mcp__notmine__display_open")).toBe("tool_call");
    expect(requestKindForTool("display_open")).toBe("tool_call");
  });
});
