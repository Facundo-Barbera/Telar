// @ts-expect-error no @types/bun in this workspace — the runtime is `bun test`
import { describe, expect, test } from "bun:test";
import {
  browserToolPhase,
  normalizeBrowserToolCall,
  shouldRevealBrowserCall,
} from "./browser-runtime";
import { isReadOnlyBrowserCall } from "../browser-mcp";

describe("controlled browser tool routing", () => {
  test("maps the read-only tab-list alias to Playwright's overloaded tabs tool", () => {
    expect(normalizeBrowserToolCall("browser_list_tabs", {})).toEqual({
      name: "browser_tabs",
      args: { action: "list" },
    });
  });

  test("leaves mutating browser calls untouched", () => {
    const args = { target: "button-1", element: "Save" };
    expect(normalizeBrowserToolCall("browser_click", args)).toEqual({
      name: "browser_click",
      args,
    });
  });

  test("reveals the surface only for successful agent-style mutations", () => {
    expect(shouldRevealBrowserCall("browser_tabs", { action: "new" })).toBe(true);
    expect(shouldRevealBrowserCall("browser_navigate", { url: "http://localhost:3000" })).toBe(true);
    expect(shouldRevealBrowserCall("browser_click", { target: "e1" })).toBe(true);
    expect(shouldRevealBrowserCall("browser_tabs", { action: "list" })).toBe(false);
    expect(shouldRevealBrowserCall("browser_snapshot", {})).toBe(false);
    expect(shouldRevealBrowserCall("browser_tabs", { action: "new" }, false)).toBe(false);
  });

  test("classifies browser actions for agent-presence feedback", () => {
    expect(browserToolPhase("browser_click")).toBe("click");
    expect(browserToolPhase("browser_type")).toBe("type");
    expect(browserToolPhase("browser_navigate")).toBe("navigate");
    expect(browserToolPhase("browser_snapshot")).toBe("inspect");
  });
});

describe("browser permission classification", () => {
  test("auto-runs inspection tools and only the list arm of browser_tabs", () => {
    expect(isReadOnlyBrowserCall("browser_list_tabs")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_snapshot")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_take_screenshot")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_tabs", { action: "list" })).toBe(true);
    expect(isReadOnlyBrowserCall("browser_tabs", { action: "new" })).toBe(false);
    expect(isReadOnlyBrowserCall("browser_click", { target: "e1" })).toBe(false);
  });
});
