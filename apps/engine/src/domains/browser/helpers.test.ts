import { describe, expect, test } from "bun:test";
import { headlessCanvasCall } from "./canvas";
import { browserErrorText, fileUrlViolation, headlessBrowserToolCall, imageDataUrlOf, isReadOnlyBrowserCall, MUTATING_TOOLS, normalizeBrowserToolCall, parseBrowserTabs, textOf } from "./helpers";
import { ScopedRuntimePool } from "./pool";
import { BROWSER_TOOLS, BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

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
    expect(normalizeBrowserToolCall("browser_list_tabs_v2", args)).toEqual({ name: "browser_list_tabs_v2", args });
  });

  test("a resize's preset and mode reach the desktop host as themselves — fit must not become a fixed standard size", () => {
    expect(normalizeBrowserToolCall("browser_resize", { mode: "fit" })).toEqual({ name: "browser_resize", args: { mode: "fit" } });
    expect(normalizeBrowserToolCall("browser_resize", { preset: "phone" })).toEqual({ name: "browser_resize", args: { preset: "phone" } });
  });

  test("the headless browser gets numbers: a preset is its size, a bare mode the standard size, explicit numbers stay", () => {
    expect(headlessBrowserToolCall("browser_resize", { preset: "phone" })).toEqual({ name: "browser_resize", args: { width: 390, height: 844 } });
    expect(headlessBrowserToolCall("browser_resize", { mode: "fit" })).toEqual({ name: "browser_resize", args: { width: 1280, height: 800 } });
    expect(headlessBrowserToolCall("browser_resize", { mode: "fixed", width: 900, height: 600 })).toEqual({ name: "browser_resize", args: { width: 900, height: 600 } });
    expect(headlessBrowserToolCall("browser_list_tabs", {})).toEqual({ name: "browser_tabs", args: { action: "list" } });
  });

  test("the headless browser: grouped presets, one dimension over the standard size, and an orientation turn", () => {
    expect(headlessBrowserToolCall("browser_resize", { preset: "ipad-air" })).toEqual({ name: "browser_resize", args: { width: 820, height: 1180 } });
    expect(headlessBrowserToolCall("browser_resize", { width: 600 })).toEqual({ name: "browser_resize", args: { width: 600, height: 800 } });
    expect(headlessBrowserToolCall("browser_resize", { height: 700 })).toEqual({ name: "browser_resize", args: { width: 1280, height: 700 } });
    expect(headlessBrowserToolCall("browser_resize", { preset: "phone", orientation: "landscape" })).toEqual({ name: "browser_resize", args: { width: 844, height: 390 } });
    expect(headlessBrowserToolCall("browser_resize", { orientation: "portrait" })).toEqual({ name: "browser_resize", args: { width: 800, height: 1280 } });
    expect(() => parseBrowserToolInput("browser_resize", headlessBrowserToolCall("browser_resize", { preset: "watch" }).args)).toThrow(/preset/);
    expect(() => parseBrowserToolInput("browser_resize", headlessBrowserToolCall("browser_resize", { orientation: "sideways" }).args)).toThrow(/orientation/);
  });

  test("browser_resize's schema: one dimension alone is valid, and so is an orientation alone", () => {
    expect(parseBrowserToolInput("browser_resize", { width: 768 })).toEqual({ width: 768 });
    expect(parseBrowserToolInput("browser_resize", { height: 600 })).toEqual({ height: 600 });
    expect(parseBrowserToolInput("browser_resize", { orientation: "landscape" })).toEqual({ orientation: "landscape" });
    expect(parseBrowserToolInput("browser_resize", { preset: "galaxy-z-fold-5" })).toEqual({ preset: "galaxy-z-fold-5" });
    expect(parseBrowserToolInput("browser_resize", { preset: "tablet" })).toEqual({ preset: "tablet" });
    expect(() => parseBrowserToolInput("browser_resize", {})).toThrow();
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
    expect(isReadOnlyBrowserCall("browser_evaluate", { fn: "() => fetch('/admin/wipe')" })).toBe(false);
    expect(isReadOnlyBrowserCall("browser_handle_dialog")).toBe(false);
  });

  test("the mutating set and the tool schemas are the same nineteen tools", () => {
    const schemaNames = BROWSER_TOOLS.map((tool) => String(tool.name));
    expect(new Set(schemaNames).size).toBe(19);
    for (const name of ["browser_drag", "browser_paste", "browser_copy"]) expect(MUTATING_TOOLS.has(name)).toBe(true);
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
    expect(parseBrowserToolInput("browser_take_screenshot", {})).toEqual({ type: "png", scale: "css" });
    expect(parseBrowserToolInput("browser_console_messages", {})).toEqual({ level: "info" });
    expect(parseBrowserToolInput("browser_network_requests", {})).toEqual({ static: false });
  });
});

describe("coordinates, for a page with no ref to act on", () => {
  test("click and hover take exactly one of a target or a point", () => {
    for (const name of ["browser_click", "browser_hover"]) {
      expect(parseBrowserToolInput(name, { target: "e1" })).toEqual({ target: "e1" });
      expect(parseBrowserToolInput(name, { x: 300, y: 200 })).toEqual({ x: 300, y: 200 });
      expect(() => parseBrowserToolInput(name, { target: "e1", x: 300, y: 200 })).toThrow(/not both/);
      expect(() => parseBrowserToolInput(name, {})).toThrow(/pass a target from browser_snapshot, or both x and y/);
      expect(() => parseBrowserToolInput(name, { x: 300 })).toThrow(BrowserToolInputError);
      expect(() => parseBrowserToolInput(name, { y: 200 })).toThrow(BrowserToolInputError);
      expect(() => parseBrowserToolInput(name, { target: "e1", x: 300 })).toThrow(BrowserToolInputError);
    }
    expect(parseBrowserToolInput("browser_click", { x: 1, y: 2, doubleClick: true, button: "right" })).toEqual({
      x: 1,
      y: 2,
      doubleClick: true,
      button: "right",
    });
  });

  test("type needs no target; drag, paste and copy parse", () => {
    expect(parseBrowserToolInput("browser_type", { text: "hello" })).toEqual({ text: "hello" });
    expect(() => parseBrowserToolInput("browser_type", { target: "", text: "x" })).toThrow(BrowserToolInputError);
    expect(parseBrowserToolInput("browser_drag", { x: 1, y: 2, toX: 3, toY: 4 })).toEqual({ x: 1, y: 2, toX: 3, toY: 4 });
    expect(() => parseBrowserToolInput("browser_drag", { x: 1, y: 2, toX: 3 })).toThrow(BrowserToolInputError);
    expect(parseBrowserToolInput("browser_paste", { text: "1\t2\n3\t4", tabId: 2 })).toEqual({ text: "1\t2\n3\t4", tabId: 2 });
    expect(() => parseBrowserToolInput("browser_paste", { text: "" })).toThrow(BrowserToolInputError);
    expect(parseBrowserToolInput("browser_copy", {})).toEqual({});
    expect(parseBrowserToolInput("browser_press_key", { key: "Control+A" })).toEqual({ key: "Control+A" });
  });

  test("the headless runtime gets its own coordinate tools", () => {
    expect(headlessCanvasCall("browser_click", { x: 3, y: 4 })).toEqual({ name: "browser_mouse_click_xy", args: { x: 3, y: 4 } });
    expect(headlessCanvasCall("browser_click", { x: 3, y: 4, doubleClick: true, button: "right" })).toEqual({
      name: "browser_mouse_click_xy",
      args: { x: 3, y: 4, button: "right", clickCount: 2 },
    });
    expect(headlessCanvasCall("browser_hover", { x: 5, y: 6 })).toEqual({ name: "browser_mouse_move_xy", args: { x: 5, y: 6 } });
    expect(headlessCanvasCall("browser_drag", { x: 1, y: 2, toX: 3, toY: 4 })).toEqual({
      name: "browser_mouse_drag_xy",
      args: { startX: 1, startY: 2, endX: 3, endY: 4 },
    });
    const byRef = { target: "e1", element: "Save", doubleClick: true };
    expect(headlessCanvasCall("browser_click", byRef)).toEqual({ name: "browser_click", args: byRef });
    expect(headlessCanvasCall("browser_type", { target: "e2", text: "x" })).toEqual({
      name: "browser_type",
      args: { target: "e2", text: "x" },
    });
  });

  test("and refuses, by name, what only the desktop browser can do", () => {
    for (const [name, args] of [
      ["browser_type", { text: "x" }],
      ["browser_paste", { text: "x" }],
      ["browser_copy", {}],
    ] as const) {
      expect(headlessCanvasCall(name, args)).toEqual({
        refusal: `${name} here needs Telar's desktop browser, which this session cannot reach right now.`,
      });
    }
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

describe("multi-tab additions", () => {
  test("parseBrowserTabs tolerates the desktop host's {…} metadata suffix and nothing looser", () => {
    const tabs = parseBrowserTabs(
      [
        "- 0: (current) [Mine](https://a.example/) {controller=agent, opened-by=agent}",
        "- 1: [Yours](https://b.example/) {controller=human, opened-by=human, loading}",
        "an error message mentioning https://evil.example/ is still not a tab",
      ].join("\n"),
    );
    expect(tabs).toEqual([
      { index: 0, title: "Mine", url: "https://a.example/", active: true },
      { index: 1, title: "Yours", url: "https://b.example/", active: false },
    ]);
  });

  test("the human's tab and the agent's are read as separate facts about separate tabs", () => {
    const tabs = parseBrowserTabs(
      [
        "- 0: (current) [Issue #12](https://a.example/) {controller=human, opened-by=human}",
        "- 1: [Docs](https://b.example/) {controller=agent, opened-by=agent, yours}",
      ].join("\n"),
    );
    expect(tabs).toEqual([
      { index: 0, title: "Issue #12", url: "https://a.example/", active: true },
      { index: 1, title: "Docs", url: "https://b.example/", active: false, agentFocus: true },
    ]);
    expect(parseBrowserTabs("- 0: [Yours truly](https://a.example/) {opened-by=agent}")[0]?.agentFocus).toBeUndefined();
  });

  test("a tab carries its own id and the profile it is signed into; absent means unknown", () => {
    const [tab] = parseBrowserTabs(
      "- 0: (current) [Mail](https://mail.example/) {tab=tab-7, controller=idle, opened-by=agent, profile=bp_00000000000000a1, profile-label=Work%20%2F%20Ana, yours}",
    );
    expect(tab).toEqual({
      index: 0,
      title: "Mail",
      url: "https://mail.example/",
      active: true,
      agentFocus: true,
      tabUid: "tab-7",
      profileId: "bp_00000000000000a1",
      profileLabel: "Work / Ana",
    });
    const bare = parseBrowserTabs("- 0: [Mail](https://mail.example/) {opened-by=agent}")[0];
    expect(bare?.profileId).toBeUndefined();
    expect(bare?.tabUid).toBeUndefined();
    const [broken] = parseBrowserTabs("- 0: [Mail](https://mail.example/) {profile=bp_00000000000000a1, profile-label=%E0%A4%A}");
    expect(broken?.profileId).toBe("bp_00000000000000a1");
    expect(broken?.profileLabel).toBeUndefined();
  });

  test("every tool accepts tabId — a write may name a tab, and a bad index is still refused", () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      ["browser_click", { target: "e1" }],
      ["browser_type", { target: "e1", text: "hi" }],
      ["browser_select_option", { target: "e1", values: ["a"] }],
      ["browser_press_key", { key: "Enter" }],
      ["browser_hover", { target: "e1" }],
      ["browser_navigate", { url: "https://example.com/" }],
      ["browser_navigate_back", {}],
      ["browser_fill_form", { fields: [] }],
    ];
    const reads: Array<[string, Record<string, unknown>]> = [
      ["browser_snapshot", {}],
      ["browser_take_screenshot", {}],
      ["browser_console_messages", {}],
      ["browser_network_requests", {}],
    ];
    for (const [name, base] of [...writes, ...reads]) {
      expect(parseBrowserToolInput(name, { ...base, tabId: 1 })).toMatchObject({ tabId: 1 });
      expect(() => parseBrowserToolInput(name, { ...base, tabId: -1 })).toThrow(BrowserToolInputError);
      expect(parseBrowserToolInput(name, base)).not.toHaveProperty("tabId");
    }
  });
});

describe("the file: fence (fileUrlViolation)", () => {
  const root = "/tmp/telar-checkout";

  test("http and https pass untouched, workspace or not", () => {
    expect(fileUrlViolation("browser_navigate", { url: "https://example.com" }, root)).toBeNull();
    expect(fileUrlViolation("browser_navigate", { url: "http://localhost:3000" }, undefined)).toBeNull();
  });

  test("a file URL inside the checkout passes; outside is refused with the fence named", () => {
    expect(fileUrlViolation("browser_navigate", { url: `file://${root}/guide.html` }, root)).toBeNull();
    expect(fileUrlViolation("browser_navigate", { url: "file:///etc/hosts" }, root)).toMatch(/only inside this session's checkout/);
    expect(fileUrlViolation("browser_navigate", { url: `file://${root}/../secrets.txt` }, root)).toMatch(/checkout/);
    expect(fileUrlViolation("browser_navigate", { url: `file://${root}-evil/x.html` }, root)).toMatch(/checkout/);
  });

  test("no workspace bound means no file URLs at all — the fence fails closed", () => {
    expect(fileUrlViolation("browser_navigate", { url: `file://${root}/guide.html` }, undefined)).toMatch(/cannot open file URLs/);
  });

  test("browser_tabs new is the other door and gets the same fence; other actions do not", () => {
    expect(fileUrlViolation("browser_tabs", { action: "new", url: "file:///etc/hosts" }, root)).toMatch(/checkout/);
    expect(fileUrlViolation("browser_tabs", { action: "new", url: `file://${root}/a.html` }, root)).toBeNull();
    expect(fileUrlViolation("browser_tabs", { action: "select", url: "file:///etc/hosts" }, root)).toBeNull();
    expect(fileUrlViolation("browser_click", { target: "e1" }, root)).toBeNull();
  });

  test("an unparseable or scheme-relative url is not this fence's question", () => {
    expect(fileUrlViolation("browser_navigate", { url: "not a url" }, root)).toBeNull();
    expect(fileUrlViolation("browser_navigate", { url: "example.com/page" }, root)).toBeNull();
  });
});
