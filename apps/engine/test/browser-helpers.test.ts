/**
 * The pure half of the engine's browser: name routing, permission
 * classification, tab parsing, tool-input validation, and the scoped pool.
 *
 * Adapted from `apps/web_old/lib/server/browser-runtime.test.ts`, with the
 * accept-only cases turned into cases that also REJECT. A suite that only ever
 * feeds a schema valid input passes just as happily over `z.unknown()`.
 */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_TOOLS,
  BrowserToolInputError,
  MUTATING_TOOLS,
  ScopedRuntimePool,
  browserErrorText,
  imageDataUrlOf,
  isReadOnlyBrowserCall,
  normalizeBrowserToolCall,
  parseBrowserTabs,
  parseBrowserToolInput,
  textOf,
  BrowserToolResult,
} from "../src/browser";

describe("browser tool routing", () => {
  test("maps the read-only tab-list alias to Playwright's overloaded tabs tool", () => {
    expect(normalizeBrowserToolCall("browser_list_tabs", {})).toEqual({
      name: "browser_tabs",
      args: { action: "list" },
    });
  });

  test("leaves every other call untouched, including its arguments", () => {
    const args = { target: "button-1", element: "Save" };
    expect(normalizeBrowserToolCall("browser_click", args)).toEqual({ name: "browser_click", args });
    // The alias is exact, not a prefix: a tool that merely starts the same way
    // must not be rewritten into a tab listing.
    expect(normalizeBrowserToolCall("browser_list_tabs_v2", args)).toEqual({ name: "browser_list_tabs_v2", args });
  });
});

describe("browser permission classification", () => {
  test("auto-runs inspection tools and only the list arm of the overloaded tabs tool", () => {
    expect(isReadOnlyBrowserCall("browser_list_tabs")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_snapshot")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_take_screenshot")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_console_messages")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_network_requests")).toBe(true);
    expect(isReadOnlyBrowserCall("browser_tabs", { action: "list" })).toBe(true);
  });

  test("gates every mutation, and an unknown tool is not assumed safe", () => {
    for (const name of MUTATING_TOOLS) {
      expect(isReadOnlyBrowserCall(name, { action: "new", target: "e1" })).toBe(false);
    }
    expect(isReadOnlyBrowserCall("browser_tabs", { action: "close", index: 0 })).toBe(false);
    expect(isReadOnlyBrowserCall("browser_tabs")).toBe(false);
    // Default-deny: a tool the engine does not define cannot be described, so
    // it cannot be auto-run. This is the case the legacy two-list version got
    // wrong the moment the lists drifted.
    expect(isReadOnlyBrowserCall("browser_evaluate", { fn: "() => fetch('/admin/wipe')" })).toBe(false);
    expect(isReadOnlyBrowserCall("browser_handle_dialog")).toBe(false);
  });

  test("the mutating set and the tool schemas are the same fourteen tools", () => {
    const schemaNames = BROWSER_TOOLS.map((tool) => String(tool.name));
    expect(new Set(schemaNames).size).toBe(14);
    // A tool that can mutate but has no schema is a tool the engine gates and
    // then cannot describe; a schema with no classification is worse.
    for (const name of MUTATING_TOOLS) expect(schemaNames).toContain(name);
  });
});

describe("browser tool input validation", () => {
  test("rejects arguments the browser would only reject after a round trip", () => {
    expect(() => parseBrowserToolInput("browser_navigate", { url: "not-a-url" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_tabs", { action: "wipe" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_tabs", { action: "select", index: 1.5 })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_tabs", { action: "select", index: -1 })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_click", {})).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_click", { target: "" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_click", { target: "e1", button: "scroll" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_type", { target: "e1" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_fill_form", { fields: [{ target: "e1", name: "n", type: "date", value: "x" }] })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_press_key", { key: "" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_take_screenshot", { type: "webp" })).toThrow(BrowserToolInputError);
  });

  test("refuses a tool it does not define rather than forwarding it", () => {
    expect(() => parseBrowserToolInput("browser_evaluate", { fn: "() => 1" })).toThrow(BrowserToolInputError);
    expect(() => parseBrowserToolInput("browser_evaluate", {})).toThrow(/Unknown browser tool/);
  });

  test("names the offending field, because the message is what the model reads", () => {
    expect(() => parseBrowserToolInput("browser_navigate", { url: "not-a-url" })).toThrow(/url/);
  });

  test("accepts valid input and applies the schema defaults", () => {
    expect(parseBrowserToolInput("browser_navigate", { url: "http://localhost:3000/x" })).toEqual({
      url: "http://localhost:3000/x",
    });
    expect(parseBrowserToolInput("browser_navigate_back")).toEqual({});
    // Defaults are applied HERE so the journal records what the browser
    // actually received, not what the model happened to type.
    expect(parseBrowserToolInput("browser_take_screenshot", {})).toEqual({ type: "png", scale: "css" });
    expect(parseBrowserToolInput("browser_console_messages", {})).toEqual({ level: "info" });
    expect(parseBrowserToolInput("browser_network_requests", {})).toEqual({ static: false });
  });
});

describe("browser tool results", () => {
  test("reads text and images out of a well-formed result", () => {
    const result = BrowserToolResult.parse({
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: "second" },
      ],
    });
    expect(textOf(result)).toBe("first\nsecond");
    expect(imageDataUrlOf(result)).toBe("data:image/jpeg;base64,AAAA");
  });

  test("tolerates a content block it does not model without dropping the result", () => {
    const parsed = BrowserToolResult.safeParse({
      content: [{ type: "resource", uri: "file:///tmp/a" }, { type: "text", text: "kept" }],
    });
    expect(parsed.success).toBe(true);
    expect(textOf(parsed.data!)).toBe("kept");
    expect(imageDataUrlOf(parsed.data!)).toBeNull();
  });

  test("does NOT let the forward-compat arm swallow a malformed known block", () => {
    // This is the whole reason the unknown arm carries a refinement. Without
    // it `{ type: "text", text: 42 }` parses as an opaque block and every
    // reader downstream silently sees no text at all.
    expect(BrowserToolResult.safeParse({ content: [{ type: "text", text: 42 }] }).success).toBe(false);
    expect(BrowserToolResult.safeParse({ content: [{ type: "image" }] }).success).toBe(false);
    expect(BrowserToolResult.safeParse({ content: [{ type: "" }] }).success).toBe(false);
    expect(BrowserToolResult.safeParse({ content: "not a list" }).success).toBe(false);
    expect(BrowserToolResult.safeParse({ content: [], isError: "yes" }).success).toBe(false);
  });
});

describe("browser error text", () => {
  test("strips the framing Playwright MCP wraps a failure in", () => {
    expect(browserErrorText("### Error\nRef e17 not found")).toBe("Ref e17 not found");
    expect(browserErrorText("Error: navigation refused")).toBe("navigation refused");
    expect(browserErrorText(new Error("boom").message)).toBe("boom");
  });

  test("leaves a message that merely mentions an error intact", () => {
    expect(browserErrorText("The page logged an Error: see console")).toBe("The page logged an Error: see console");
  });
});

describe("tab parsing", () => {
  test("reads the markdown-link listing Playwright emits", () => {
    const tabs = parseBrowserTabs(
      ["- 0: (current) [Telar](http://localhost:3000/)", "- 1: [Docs](https://example.com/docs)"].join("\n"),
    );
    expect(tabs).toEqual([
      { index: 0, title: "Telar", url: "http://localhost:3000/", active: true },
      { index: 1, title: "Docs", url: "https://example.com/docs", active: false },
    ]);
  });

  test("still reads the older trailing-marker rendering", () => {
    expect(parseBrowserTabs("- 0: Some title - https://example.com [current]")).toEqual([
      { index: 0, title: "Some title", url: "https://example.com", active: true },
    ]);
  });

  test("does not invent tabs out of prose that happens to contain a URL", () => {
    // The failure this guards is a real one: a loose pattern turns an error
    // message mentioning a link into a browser tab that does not exist.
    expect(parseBrowserTabs("Navigation failed for http://localhost:3000/ — connection refused")).toEqual([]);
    expect(parseBrowserTabs("See https://example.com for details")).toEqual([]);
    expect(parseBrowserTabs("")).toEqual([]);
    expect(parseBrowserTabs("### Error\nNo open tabs")).toEqual([]);
  });
});

describe("the scoped browser pool", () => {
  const resource = (name: string, disposed: string[], busy = false) => ({
    name,
    isBusy: () => busy,
    dispose: (reason: string) => void disposed.push(`${name}:${reason}`),
  });

  test("switching sessions retains each scope's browser", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(6);
    const first = pool.acquire("session:a", () => resource("a", disposed));
    const second = pool.acquire("session:b", () => resource("b", disposed));

    expect(pool.acquire("session:a", () => resource("replacement", disposed))).toBe(first);
    expect(pool.peek("session:b")).toBe(second);
    expect(pool.size).toBe(2);
    expect(disposed).toEqual([]);
  });

  test("never evicts a browser while a detached agent is using it", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(1);
    const background = pool.acquire("session:a", () => resource("background", disposed, true));
    pool.acquire("session:b", () => resource("foreground", disposed));

    expect(pool.peek("session:a")).toBe(background);
    expect(pool.size).toBe(2);
    expect(disposed).toEqual([]);
  });

  test("reclaims the least-recently-used idle browser at the capacity boundary", () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(2);
    pool.acquire("session:a", () => resource("a", disposed));
    pool.acquire("session:b", () => resource("b", disposed));
    pool.acquire("session:b", () => resource("replacement", disposed));
    pool.acquire("session:c", () => resource("c", disposed));

    expect(pool.peek("session:a")).toBeNull();
    expect(pool.peek("session:b")?.name).toBe("b");
    expect(pool.peek("session:c")?.name).toBe("c");
    expect(disposed).toEqual(["a:The inactive browser session was reclaimed."]);
  });

  test("releases a scope on demand — the removal path the legacy pool had no way to reach", async () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(6);
    pool.acquire("session:a", () => resource("a", disposed));

    expect(await pool.release("session:a", "session ended")).toBe(true);
    expect(disposed).toEqual(["a:session ended"]);
    // Releasing a scope that was never pooled says so, so a caller can tell
    // "freed a browser" from "there was never one" without peeking first.
    expect(await pool.release("session:a")).toBe(false);
  });

  test("release is unconditional: a busy resource whose session is over is a leak, not work", async () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(6);
    pool.acquire("session:a", () => resource("busy", disposed, true));

    expect(await pool.release("session:a", "session archived")).toBe(true);
    expect(pool.peek("session:a")).toBeNull();
    expect(pool.size).toBe(0);
  });

  test("clear disposes everything and leaves the pool reusable", async () => {
    const disposed: string[] = [];
    const pool = new ScopedRuntimePool<ReturnType<typeof resource>>(6);
    pool.acquire("session:a", () => resource("a", disposed, true));
    pool.acquire("session:b", () => resource("b", disposed));

    await pool.clear("shutting down");
    expect(disposed.sort()).toEqual(["a:shutting down", "b:shutting down"]);
    expect(pool.size).toBe(0);
    expect(pool.keys()).toEqual([]);

    pool.acquire("session:c", () => resource("c", disposed));
    expect(pool.size).toBe(1);
  });
});
