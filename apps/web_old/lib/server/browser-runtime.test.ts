// @ts-expect-error no @types/bun in this workspace — the runtime is `bun test`
import { describe, expect, test } from "bun:test";
import {
  browserToolPhase,
  normalizeBrowserToolCall,
  ScopedRuntimePool,
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

describe("scoped browser runtime ownership", () => {
  const resource = (name: string, disposed: string[], busy = false) => ({
    name,
    isBusy: () => busy,
    dispose: () => disposed.push(name),
  });

  test("switching conversations retains each scope's browser", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(6);
    const first = pool.acquire("project:chat-a", () => resource("a", disposed));
    const second = pool.acquire("project:chat-b", () => resource("b", disposed));

    expect(pool.acquire("project:chat-a", () => resource("replacement", disposed))).toBe(first);
    expect(pool.peek("project:chat-b")).toBe(second);
    expect(pool.size).toBe(2);
    expect(disposed).toEqual([]);
  });

  test("never evicts a browser while a background agent is using it", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(1);
    const background = pool.acquire("project:chat-a", () => resource("background", disposed, true));
    pool.acquire("project:chat-b", () => resource("foreground", disposed));

    expect(pool.peek("project:chat-a")).toBe(background);
    expect(pool.size).toBe(2);
    expect(disposed).toEqual([]);
  });

  test("reclaims the least-recently-used idle browser at the capacity boundary", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(2);
    pool.acquire("project:chat-a", () => resource("a", disposed));
    pool.acquire("project:chat-b", () => resource("b", disposed));
    pool.acquire("project:chat-b", () => resource("replacement", disposed));
    pool.acquire("project:chat-c", () => resource("c", disposed));

    expect(pool.peek("project:chat-a")).toBeNull();
    expect(pool.peek("project:chat-b")?.name).toBe("b");
    expect(pool.peek("project:chat-c")?.name).toBe("c");
    expect(disposed).toEqual(["a"]);
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
