const { describe, expect, test } = require("bun:test");

const { makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("hidden screenshots", () => {
  test("a fullPage capture that never settles still restores the tab's viewport", async () => {
    const { manager, views } = makeHarness();
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://one.example/" });
    const view = views[0];
    const wc = view.webContents;
    const tab = manager.activeTab("s");

    wc.capturePage = () => new Promise(() => {});
    const debug = wc.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("scrollHeight")) return { result: { value: { width: 1280, height: 4000 } } };
      return originalSend(method, params);
    };

    const started = Date.now();
    const result = await Promise.race([
      manager.callTool("s", "browser_take_screenshot", { fullPage: true }),
      new Promise((resolve) => setTimeout(() => resolve({ isError: true, content: [{ type: "text", text: "test deadline" }] }), 9_000)),
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(9_000);
    const overrides = debug.commands.filter((entry) => entry.method === "Emulation.setDeviceMetricsOverride").map((entry) => `${entry.params.width}x${entry.params.height}`);

    expect(overrides).toEqual(["1280x800", "1280x4000", "1280x800"]);
    expect(tab.viewportOverride).toBe("1280x800@1");
  }, 15_000);
});

describe("the cockpit's own capture", () => {
  test("a fixed tab under a 0.5 fit scale is captured at the tab's own scale, not the panel's", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.state("s").presentation.scale).toBe(0.5);
    const shot = await manager.capture("s");

    const clip = views[0].webContents.debugger.commands.filter((c) => c.method === "Page.captureScreenshot").at(-1);
    expect(clip.params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true, fromSurface: true });
    expect(shot).toMatchObject({ data: "cG5n", mimeType: "image/png", url: "https://one.example/", width: 1280, height: 800, fullPage: false });
  });

  test("it reads the HUMAN's active tab, never the agent's", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/");

    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://agent.example/" });
    await manager.action("s", { action: "select", index: 0 });
    expect(manager.activeTab("s").url).toBe("https://one.example/");
    expect((await manager.capture("s")).url).toBe("https://one.example/");
  });

  test("a full-page capture asks for the document's height, and says it did", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 1280, height: 800 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("scrollHeight")) return { result: { value: { width: 1280, height: 4000 } } };
      return originalSend(method, params);
    };
    const shot = await manager.capture("s", { fullPage: true });
    expect(shot.fullPage).toBe(true);
    expect(debug.commands.filter((c) => c.method === "Page.captureScreenshot").at(-1).params.clip).toMatchObject({ height: 4000, scale: 1 });
  });

  test("element boxes ride the same call, so the frame and what can be picked on it are one moment", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("getBoundingClientRect")) {
        return { result: { value: [{ role: "button", name: "Save", selector: "#save", x: 10, y: 20, width: 80, height: 32 }] } };
      }
      return originalSend(method, params);
    };
    expect((await manager.capture("s", { elements: true })).elements).toEqual([
      { role: "button", name: "Save", selector: "#save", x: 10, y: 20, width: 80, height: 32 },
    ]);

    expect((await manager.capture("s")).elements).toBeUndefined();
  });

  test("a blank tab and an empty scope are refused with a sentence, not an empty PNG", async () => {
    const { manager } = makeHarness();
    await expect(manager.capture("s")).rejects.toThrow(/no page here/i);
    await manager.createTab("s", "about:blank");
    await expect(manager.capture("s")).rejects.toThrow(/no page loaded/i);
  });
});

describe("acting on a page with no refs — coordinates, focus, chords, paste and copy", () => {
  const { keyChord } = require("./browser-manager");

  async function canvasTab({ mode = "fixed", page = {} } = {}) {
    const harness = makeHarness();
    const { manager, views } = harness;
    await manager.createTab("s", "https://sheet.example/");
    const tab = manager.activeTab("s");
    if (mode === "fixed") {
      await manager.resizeTab(tab, { preset: "default" });
      manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
      await manager.setVisible("s", true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
      await manager.setVisible("s", true);
      await manager.resizeTab(tab, { mode: "fit" });
    }
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      const answer = await originalSend(method, params);
      if (method !== "Runtime.evaluate") return answer;
      const expression = String(params?.expression || "");
      if (page.throws && !expression.includes("__telar_agent_cursor__")) {
        return { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: frozen\n    at <anonymous>" } } };
      }
      if (expression.includes('new ClipboardEvent("paste"')) return { result: { value: page.paste } };
      if (expression.includes('new ClipboardEvent("copy"')) return { result: { value: page.copy } };
      if (expression.includes("elementFromPoint")) return { result: { value: page.atPoint ?? null } };
      if (expression.includes("deepestFocus()")) return { result: { value: page.focused ?? null } };
      return answer;
    };

    await manager.callTool("s", "browser_snapshot", {});
    const mouse = () => debug.commands.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
    return { ...harness, tab, debug, mouse };
  }

  test("a click by coordinates lands at the SCALED native point under a fixed tab at 0.5 and names what was there", async () => {
    const { manager, mouse } = await canvasTab({ page: { atPoint: { role: "canvas", name: "" } } });
    const result = await manager.callTool("s", "browser_click", { x: 300, y: 200 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("Clicked at (300, 200): canvas.");
    expect(mouse().map(({ type, x, y }) => ({ type, x, y }))).toEqual([
      { type: "mouseMoved", x: 150, y: 100 },
      { type: "mousePressed", x: 150, y: 100 },
      { type: "mouseReleased", x: 150, y: 100 },
    ]);
  });

  test("under fit the screenshot IS the native viewport: the point is dispatched unscaled", async () => {
    const { manager, mouse } = await canvasTab({ mode: "fit", page: { atPoint: { role: "gridcell", name: "B7" } } });
    const result = await manager.callTool("s", "browser_click", { x: 300, y: 200, doubleClick: true });
    expect(textOf(result)).toBe('Clicked at (300, 200): gridcell "B7".');
    expect(mouse().find((p) => p.type === "mousePressed")).toMatchObject({ x: 300, y: 200, clickCount: 2 });
  });

  test("a point outside the screenshot's viewport, neither a ref nor a point, or both, is refused before any input", async () => {
    const { manager, mouse } = await canvasTab();
    const outside = await manager.callTool("s", "browser_click", { x: 1280, y: 10 });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toBe("Error: (1280, 10) is outside the 1280×800 viewport of the screenshot. Scroll or resize, then take a fresh screenshot.");
    const neither = await manager.callTool("s", "browser_click", {});
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain("Pass a target from browser_snapshot, or x and y");
    const both = await manager.callTool("s", "browser_click", { target: "e1", x: 10, y: 10 });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("not both");
    const half = await manager.callTool("s", "browser_hover", { x: 10 });
    expect(half.isError).toBe(true);
    expect(textOf(half)).toContain("x and y go together");
    expect(mouse()).toEqual([]);
  });

  test("the ref path keeps its own words", async () => {
    const { manager } = await canvasTab();
    expect(textOf(await manager.callTool("s", "browser_click", { target: "e1", element: "Count" }))).toBe("Clicked Count.");
  });

  test("a click still lands when the page will not say what is at the point", async () => {
    const { manager, mouse } = await canvasTab({ page: { throws: true } });
    const result = await manager.callTool("s", "browser_click", { x: 10, y: 20 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("Clicked at (10, 20).");
    expect(mouse().some((p) => p.type === "mousePressed")).toBe(true);
  });

  test("hover by coordinates moves the pointer to the scaled point and shows the agent cursor at the CSS point", async () => {
    const { manager, mouse, messages } = await canvasTab({ page: { atPoint: { role: "button", name: "Bold" } } });
    const result = await manager.callTool("s", "browser_hover", { x: 50, y: 60 });
    expect(textOf(result)).toBe('Hovered at (50, 60): button "Bold".');
    expect(mouse()).toEqual([{ type: "mouseMoved", x: 25, y: 30 }]);
    expect(messages.filter((m) => m.channel === "telar:browser:pointer").at(-1).payload).toMatchObject({ phase: "move", x: 50, y: 60 });
  });

  test("a drag presses at the start, moves with the button held, and releases at the end", async () => {
    const { manager, mouse } = await canvasTab();
    const result = await manager.callTool("s", "browser_drag", { x: 100, y: 100, toX: 300, toY: 200 });
    expect(textOf(result)).toBe("Dragged from (100, 100) to (300, 200).");
    const events = mouse();
    expect(events[0]).toEqual({ type: "mouseMoved", x: 50, y: 50 });
    expect(events[1]).toMatchObject({ type: "mousePressed", x: 50, y: 50, button: "left" });
    expect(events.at(-1)).toMatchObject({ type: "mouseReleased", x: 150, y: 100, button: "left" });
    const held = events.slice(2, -1);
    expect(held.length).toBeGreaterThan(1);
    expect(held.every((p) => p.type === "mouseMoved" && p.button === "left")).toBe(true);
    const off = await manager.callTool("s", "browser_drag", { x: 100, y: 100, toX: 100, toY: 900 });
    expect(textOf(off)).toContain("(100, 900) is outside the 1280×800 viewport");
  });

  test("type with no target inserts at focus without clearing it, and refuses when nothing editable has focus", async () => {
    const { manager, debug } = await canvasTab({ page: { focused: { role: "textbox", name: "Formula" } } });
    const result = await manager.callTool("s", "browser_type", { text: "=SUM(A1:A3)" });
    expect(textOf(result)).toBe('Typed into the focused textbox "Formula".');
    expect(debug.commands.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["=SUM(A1:A3)"]);
    expect(debug.commands.some((c) => c.method === "DOM.resolveNode" || c.method === "Runtime.callFunctionOn")).toBe(false);

    const blank = await canvasTab();
    const refused = await blank.manager.callTool("s", "browser_type", { text: "x" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("Error: Nothing editable has focus in this tab. Click into a field or a cell first (a spreadsheet's name box or formula bar), or pass a target.");
    expect(blank.debug.commands.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  test("keyChord speaks Electron's key names and modifiers", () => {
    expect(keyChord("Control+A")).toEqual({ keyCode: "A", modifiers: ["control"] });
    expect(keyChord("Meta+V")).toEqual({ keyCode: "V", modifiers: ["meta"] });
    expect(keyChord("Shift+Tab")).toEqual({ keyCode: "Tab", modifiers: ["shift"] });
    expect(keyChord("ArrowDown")).toEqual({ keyCode: "Down", modifiers: [] });
    expect(keyChord("Alt+ArrowLeft")).toEqual({ keyCode: "Left", modifiers: ["alt"] });
    expect(keyChord("Enter")).toEqual({ keyCode: "Enter", modifiers: [] });
    expect(keyChord("ControlOrMeta+C", "darwin")).toEqual({ keyCode: "C", modifiers: ["meta"] });
    expect(keyChord("ControlOrMeta+C", "linux")).toEqual({ keyCode: "C", modifiers: ["control"] });
    expect(keyChord("Shift++")).toEqual({ keyCode: "+", modifiers: ["shift"] });
    expect(keyChord("+")).toEqual({ keyCode: "+", modifiers: [] });
    expect(keyChord("Cmd+Shift+Z")).toEqual({ keyCode: "Z", modifiers: ["meta", "shift"] });
    expect(() => keyChord("Hyper+A")).toThrow("Unknown modifier Hyper in Hyper+A. Use Control, Meta, Alt, Shift or ControlOrMeta.");
  });

  test("browser_press_key sends a chord as one keyDown/keyUp carrying its modifiers", async () => {
    const { manager, views } = await canvasTab();
    const result = await manager.callTool("s", "browser_press_key", { key: "Meta+V" });
    expect(textOf(result)).toBe("Pressed Meta+V.");
    expect(views[0].webContents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "V", modifiers: ["meta"] },
      { type: "keyUp", keyCode: "V", modifiers: ["meta"] },
    ]);
    const unknown = await manager.callTool("s", "browser_press_key", { key: "Hyper+A" });
    expect(unknown.isError).toBe(true);
    expect(views[0].webContents.inputEvents).toHaveLength(2);
  });

  test("paste: a page that handles the event takes it; otherwise the focused editable gets it inserted; otherwise it is refused", async () => {
    const handled = await canvasTab({ page: { paste: { handled: true, editable: { role: "textbox", name: "" } } } });
    const pasted = await handled.manager.callTool("s", "browser_paste", { text: "1\t2\n3\t4" });
    expect(textOf(pasted)).toBe("Pasted 7 characters; the page handled the paste event.");
    const expression = handled.debug.commands.find((c) => c.method === "Runtime.evaluate" && c.params.expression.includes('"paste"')).params;
    expect(expression.returnByValue).toBe(true);
    expect(expression.expression).toContain(JSON.stringify("1\t2\n3\t4"));
    expect(handled.debug.commands.some((c) => c.method === "Input.insertText")).toBe(false);

    expect(handled.clipboard.text).toBe("");

    const fallback = await canvasTab({ page: { paste: { handled: false, editable: { role: "textarea", name: "Notes" } } } });
    const inserted = await fallback.manager.callTool("s", "browser_paste", { text: "hello" });
    expect(textOf(inserted)).toBe('Inserted 5 characters at the focused textarea "Notes"; the page did not handle a paste event.');
    expect(fallback.debug.commands.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["hello"]);

    const nobody = await canvasTab({ page: { paste: { handled: false, editable: null } } });
    const refused = await nobody.manager.callTool("s", "browser_paste", { text: "x" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("Error: Nothing took the paste: nothing editable has focus and the page did not handle a paste event. Click into a cell or field first.");
  });

  test("copy: the page's handler text verbatim, else the selection, else refused; capped at 16 KB", async () => {
    const handler = await canvasTab({ page: { copy: "a\tb\nc\td" } });
    expect(textOf(await handler.manager.callTool("s", "browser_copy", {}))).toBe("a\tb\nc\td");
    const empty = await canvasTab({ page: { copy: "" } });
    const refused = await empty.manager.callTool("s", "browser_copy", {});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("Error: Nothing is selected in this tab. Select text or cells first.");
    const big = await canvasTab({ page: { copy: "é".repeat(10_000) } });
    const capped = textOf(await big.manager.callTool("s", "browser_copy", {}));
    expect(capped.endsWith("\n… [truncated]")).toBe(true);
    expect(Buffer.byteLength(capped.replace("\n… [truncated]", ""))).toBeLessThanOrEqual(16 * 1024);
    expect(capped).not.toContain("�");
  });

  test("the page scripts: copy falls back to the selection, and focus is found inside a frame's contenteditable body", async () => {
    const vm = require("node:vm");
    const { manager, debug } = await canvasTab({ page: { copy: "x", paste: { handled: true } } });
    await manager.callTool("s", "browser_copy", {});
    await manager.callTool("s", "browser_paste", { text: "1\t2" });
    const sent = (needle) => debug.commands.find((c) => c.method === "Runtime.evaluate" && c.params.expression.includes(needle)).params.expression;
    class DataTransfer { constructor() { this.data = new Map(); } setData(type, value) { this.data.set(type, value); } getData(type) { return this.data.get(type) || ""; } }
    class ClipboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
    const run = (expression, document) => vm.runInNewContext(expression, { document, DataTransfer, ClipboardEvent });
    const element = (fields) => ({ getAttribute: () => null, textContent: "", dispatchEvent: () => true, ...fields });

    const copy = sent('"copy"');
    const handler = element({ tagName: "DIV", dispatchEvent: (event) => { event.clipboardData.setData("text/plain", "a\tb"); return false; } });
    expect(run(copy, { activeElement: handler, getSelection: () => "ignored" })).toBe("a\tb");
    const textarea = element({ tagName: "TEXTAREA", value: "hello world", selectionStart: 6, selectionEnd: 11 });
    expect(run(copy, { activeElement: textarea })).toBe("world");
    const body = element({ tagName: "BODY", isContentEditable: false });
    expect(run(copy, { activeElement: body, getSelection: () => "picked text" })).toBe("picked text");

    const paste = sent('"paste"');
    const cellBody = element({ tagName: "BODY", isContentEditable: true, textContent: "  Q3   totals " });
    const frame = element({ tagName: "IFRAME", contentDocument: { activeElement: cellBody } });
    expect(JSON.parse(JSON.stringify(run(paste, { activeElement: frame })))).toEqual({ handled: false, editable: { role: "body", name: "Q3 totals" } });
    expect(JSON.parse(JSON.stringify(run(paste, { activeElement: body })))).toEqual({ handled: false, editable: null });
    const checkbox = element({ tagName: "INPUT", type: "checkbox" });
    expect(JSON.parse(JSON.stringify(run(paste, { activeElement: checkbox })))).toEqual({ handled: false, editable: null });
  });

  test("a page that throws while being read is answered in a sentence", async () => {
    const { manager } = await canvasTab({ page: { throws: true } });
    const result = await manager.callTool("s", "browser_copy", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: The page threw while Telar read it (TypeError: frozen). Take a fresh screenshot and try again.");
  });
});
