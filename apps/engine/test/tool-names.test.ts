/**
 * Telar's own tool namespace.
 *
 * The rule these tests hold is the one t3 code arrived at: ONE MCP server, and
 * a capability legible in every tool name. The bug they exist to prevent is not
 * hypothetical — before this, the browser was a server called `browser` holding
 * tools called `browser_*`, and the resulting `mcp__browser__browser_navigate`
 * matched the generic `mcp__` arm of the item mapping. `browser_action` was in
 * the contract, drawn by the cockpit, and unreachable.
 */
import { expect, test } from "bun:test";
import { BROWSER_TOOLS } from "../src/browser";
import { itemDetailForToolCall, titleForToolCall } from "../src/driver";
import {
  assertTelarToolNames,
  displayToolName,
  parseToolName,
  qualifyTelarTool,
  TELAR_CAPABILITIES,
  TELAR_MCP_SERVER,
} from "@telar/engine-client";

test("every tool Telar exposes declares its capability in its name", () => {
  // THE STANDARD, enforced rather than documented. A tool added without its
  // prefix would land in the generic MCP bucket and lose its row type; this
  // fails the build instead.
  expect(() => assertTelarToolNames(BROWSER_TOOLS.map((tool) => tool.name))).not.toThrow();
  expect(() => assertTelarToolNames(["navigate"])).toThrow(/must be prefixed/);
  expect(() => assertTelarToolNames(["loom_open"])).toThrow(/must be prefixed/);
});

test("one server holds every capability, rather than one server per toolkit", () => {
  expect(qualifyTelarTool("browser_navigate")).toBe("mcp__telar__browser_navigate");
  // The stutter this replaced: `mcp__browser__browser_navigate`.
  expect(qualifyTelarTool("browser_navigate")).not.toContain("browser__browser");
  expect(TELAR_CAPABILITIES).toContain("browser");
});

test("a tool name splits into server, tool and capability — keeping the whole tool", () => {
  expect(parseToolName("mcp__telar__browser_click")).toEqual({
    server: TELAR_MCP_SERVER,
    tool: "browser_click",
    capability: "browser",
  });
  // Someone else's server: a server, no capability of ours.
  expect(parseToolName("mcp__linear__search")).toEqual({ server: "linear", tool: "search" });
  // A tool whose OWN name contains `__`. The previous `split("__")[1]` read
  // discarded everything past the server.
  expect(parseToolName("mcp__github__fetch__pr")).toEqual({ server: "github", tool: "fetch__pr" });
  // Not qualified at all.
  expect(parseToolName("Bash")).toEqual({ tool: "Bash" });
  // Qualified-looking but incomplete — treated as an opaque name, not split.
  expect(parseToolName("mcp__telar")).toEqual({ tool: "mcp__telar" });
  // A telar tool with no known capability prefix stays an mcp tool rather than
  // being forced into a row type we cannot render.
  expect(parseToolName("mcp__telar__mystery")).toEqual({ server: TELAR_MCP_SERVER, tool: "mystery" });
});

test("a browser call is a browser_action, which nothing produced before", () => {
  const detail = itemDetailForToolCall("mcp__telar__browser_navigate", { url: "https://example.com" });
  expect(detail.type).toBe("browser_action");
  expect(detail.type === "browser_action" && detail.url).toBe("https://example.com");
  // The stored name stays fully qualified — it is what correlates the row with
  // the approval and with the provider's own tool_use.
  expect(detail.type === "browser_action" && detail.call.name).toBe("mcp__telar__browser_navigate");
  expect(detail.type === "browser_action" && detail.call.server).toBe(TELAR_MCP_SERVER);

  // A call that acts on wherever the tab already is carries no url.
  const click = itemDetailForToolCall("mcp__telar__browser_click", { ref: "e12" });
  expect(click.type === "browser_action" && click.url).toBeUndefined();
});

test("someone else's MCP server is still an mcp_tool_call", () => {
  // Anti-vacuity: the capability arm must not swallow every MCP tool.
  const detail = itemDetailForToolCall("mcp__linear__search", { q: "x" });
  expect(detail.type).toBe("mcp_tool_call");
  expect(detail.type === "mcp_tool_call" && detail.call.server).toBe("linear");
});

test("labels drop the addressing, the stored name keeps it", () => {
  expect(displayToolName("mcp__telar__browser_click")).toBe("browser_click");
  expect(displayToolName("Bash")).toBe("Bash");
  expect(
    titleForToolCall("mcp__telar__browser_navigate", itemDetailForToolCall("mcp__telar__browser_navigate", { url: "https://example.com/x" })),
  ).toBe("browser_navigate → https://example.com/x");
  expect(
    titleForToolCall("mcp__telar__browser_click", itemDetailForToolCall("mcp__telar__browser_click", {})),
  ).toBe("browser_click");
  expect(titleForToolCall("mcp__linear__search", itemDetailForToolCall("mcp__linear__search", {}))).toBe("search");
});
