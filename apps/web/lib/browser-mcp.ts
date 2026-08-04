import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { controlledBrowserRuntime } from "@/lib/server/browser-runtime";

type BrowserToolOptions = { scopeKey?: string };

// `browser` is the natural MCP server name and remains the Claude namespace,
// but the Responses API reserves that namespace for its own browser surface.
// Codex dynamic tools therefore use a Telar-qualified alias. Only the dynamic
// adapter sees this spelling; the shared T3-derived browser host and every
// actual tool definition remain identical across harnesses.
export const CODEX_BROWSER_TOOL_NAMESPACE = "telar_browser";

const call = (name: string, options: BrowserToolOptions) =>
  async (args: Record<string, unknown>) =>
    controlledBrowserRuntime().call(name, args, { scopeKey: options.scopeKey });

export const BROWSER_READ_TOOLS = [
  "mcp__browser__browser_list_tabs",
  "mcp__browser__browser_snapshot",
  "mcp__browser__browser_take_screenshot",
  "mcp__browser__browser_console_messages",
  "mcp__browser__browser_network_requests",
] as const;

export function isReadOnlyBrowserCall(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  if (name === "browser_tabs") return args.action === "list";
  return (BROWSER_READ_TOOLS as readonly string[]).includes(`mcp__browser__${name}`);
}

export function browserTools(options: BrowserToolOptions = {}) {
  return [
    tool("browser_list_tabs", "List the tabs currently open in Telar's integrated browser without changing them. Use this first when the user refers to a visible page or open browser tab.", {}, call("browser_list_tabs", options)),
    tool("browser_tabs", "List, create, close, or select a tab in Telar's integrated browser. List tabs before acting when the user has more than one open.", {
      action: z.enum(["list", "new", "close", "select"]),
      index: z.number().optional(),
      url: z.string().optional(),
    }, call("browser_tabs", options)),
    tool("browser_navigate", "Navigate the selected Telar browser tab to an http or https URL.", {
      url: z.string().url(),
    }, call("browser_navigate", options)),
    tool("browser_navigate_back", "Go back in the selected Telar browser tab.", {}, call("browser_navigate_back", options)),
    tool("browser_snapshot", "Read the accessibility snapshot of the selected Telar browser tab. Use its exact target refs for interactions.", {
      target: z.string().optional(),
      depth: z.number().optional(),
      boxes: z.boolean().optional(),
    }, call("browser_snapshot", options)),
    tool("browser_click", "Click an element in the selected Telar browser tab using a target from browser_snapshot.", {
      target: z.string(),
      element: z.string().optional(),
      doubleClick: z.boolean().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    }, call("browser_click", options)),
    tool("browser_type", "Type text into an editable element in the selected Telar browser tab.", {
      target: z.string(),
      element: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
    }, call("browser_type", options)),
    tool("browser_fill_form", "Fill several fields in the selected Telar browser tab.", {
      fields: z.array(z.object({
        target: z.string(),
        element: z.string().optional(),
        name: z.string(),
        type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]),
        value: z.string(),
      })),
    }, call("browser_fill_form", options)),
    tool("browser_select_option", "Select values in a dropdown in the selected Telar browser tab.", {
      target: z.string(),
      element: z.string().optional(),
      values: z.array(z.string()),
    }, call("browser_select_option", options)),
    tool("browser_press_key", "Press a keyboard key in the selected Telar browser tab.", {
      key: z.string(),
    }, call("browser_press_key", options)),
    tool("browser_hover", "Move Telar's visible agent cursor over an element in the selected browser tab.", {
      target: z.string(),
      element: z.string().optional(),
    }, call("browser_hover", options)),
    tool("browser_take_screenshot", "Capture the selected Telar browser tab for visual inspection. Use browser_snapshot for element targeting.", {
      type: z.enum(["png", "jpeg"]).default("png"),
      fullPage: z.boolean().optional(),
      scale: z.enum(["css", "device"]).default("css"),
    }, call("browser_take_screenshot", options)),
    tool("browser_console_messages", "Read console messages from the selected Telar browser tab.", {
      level: z.enum(["error", "warning", "info", "debug"]).default("info"),
      all: z.boolean().optional(),
    }, call("browser_console_messages", options)),
    tool("browser_network_requests", "Read network requests from the selected Telar browser tab.", {
      static: z.boolean().default(false),
      filter: z.string().optional(),
    }, call("browser_network_requests", options)),
  ];
}

export const BROWSER_MCP_VERSION = "1.1.0";

export function createBrowserMcpServer(options: BrowserToolOptions = {}): McpServerConfig {
  return createSdkMcpServer({
    name: "browser",
    version: BROWSER_MCP_VERSION,
    tools: browserTools(options),
  });
}
