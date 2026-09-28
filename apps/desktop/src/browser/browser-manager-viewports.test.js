const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager } = require("./browser-manager");
const { FakeView, makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("per-tab viewports — intrinsic size independent of the column, presentation-only fit", () => {
  const { fitViewport, resolveViewport } = require("./browser-manager");

  test("fitViewport scales down to fit, centres on both axes, never scales up", () => {
    expect(fitViewport({ width: 1280, height: 800 }, { x: 10, y: 20, width: 640, height: 400 })).toEqual({ scale: 0.5, rect: { x: 10, y: 20, width: 640, height: 400 } });
    expect(fitViewport({ width: 1280, height: 800 }, { x: 0, y: 0, width: 640, height: 600 })).toEqual({ scale: 0.5, rect: { x: 0, y: 100, width: 640, height: 400 } });
    expect(fitViewport({ width: 390, height: 844 }, { x: 0, y: 30, width: 1000, height: 900 })).toEqual({ scale: 1, rect: { x: 305, y: 58, width: 390, height: 844 } });
  });

  test("a presentation zoom scales the page below fit, never past it", () => {
    const { resolveZoom } = require("./browser-manager");
    expect(fitViewport({ width: 390, height: 844 }, { x: 0, y: 0, width: 1000, height: 900 }, 0.5)).toEqual({ scale: 0.5, rect: { x: 402, y: 239, width: 195, height: 422 } });
    expect(fitViewport({ width: 1280, height: 800 }, { x: 0, y: 0, width: 640, height: 400 }, 1).scale).toBe(0.5);
    expect(resolveZoom("fit")).toBe("fit");
    expect(resolveZoom(0.75)).toBe(0.75);
    expect(() => resolveZoom(2)).toThrow(/Unknown zoom/);
  });

  test("resolveViewport accepts presets and clamps custom sizes", () => {
    expect(resolveViewport({ preset: "tablet" })).toEqual({ width: 768, height: 1024 });
    expect(resolveViewport({ width: 50, height: 99999 })).toEqual({ width: 200, height: 5000 });
    expect(resolveViewport({ width: 5000, height: 5000 })).toEqual({ width: 5000, height: 3000 });
    expect(() => resolveViewport({ preset: "watch" })).toThrow(/Unknown viewport preset/);
    expect(() => resolveViewport({})).toThrow(/numeric width and height/);
  });

  test("resolveViewport takes the grouped presets, one dimension alone, and an orientation", () => {
    expect(resolveViewport({ preset: "ipad-air" })).toEqual({ width: 820, height: 1180 });
    expect(resolveViewport({ preset: "phone" })).toEqual({ width: 390, height: 844 });

    expect(resolveViewport({ width: 600 }, { width: 1440, height: 900 })).toEqual({ width: 600, height: 900 });
    expect(resolveViewport({ height: 700 }, { width: 1440, height: 900 })).toEqual({ width: 1440, height: 700 });
    expect(resolveViewport({ width: 600 })).toEqual({ width: 600, height: 800 });

    expect(resolveViewport({ preset: "iphone-se", orientation: "landscape" })).toEqual({ width: 667, height: 375 });
    expect(resolveViewport({ preset: "default", orientation: "landscape" })).toEqual({ width: 1280, height: 800 });
    expect(resolveViewport({ orientation: "portrait" }, { width: 1280, height: 800 })).toEqual({ width: 800, height: 1280 });
    expect(() => resolveViewport({ preset: "phone", orientation: "sideways" })).toThrow(/Unknown orientation/);
  });

  test("a FIXED tab in a narrow panel keeps the page at 1280×800 and scales the presentation; hidden tabs are emulated at scale 1", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    await manager.callTool("s", "browser_snapshot", {});

    const hidden = debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    expect(hidden.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);

    expect(shown.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 0.5, dontSetVisibleSize: true });
    expect(debug.commands.filter((c) => c.method === "Emulation.setVisibleSize").at(-1).params).toEqual({ width: 640, height: 400 });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
    expect(manager.state("s").presentation).toMatchObject({ width: 1280, height: 800, scale: 0.5, rect: { width: 640, height: 400 } });

    await manager.callTool("s", "browser_snapshot", {});
    await manager.callTool("s", "browser_click", { target: "e1" });
    const pressed = debug.commands.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");

    expect(pressed.params).toMatchObject({ x: 60, y: 40 });

    await manager.callTool("s", "browser_take_screenshot", {});
    const shot = debug.commands.find((c) => c.method === "Page.captureScreenshot");
    expect(shot.params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true });
  });

  test("a divider step on a shown FIXED tab sends the new scale BEFORE the view takes the new rect", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const view = views[0];
    const debug = view.webContents.debugger;

    const log = [];
    const setBounds = view.setBounds.bind(view);
    view.setBounds = (rect) => { log.push(`bounds ${rect.width}x${rect.height}`); setBounds(rect); };
    const send = debug.sendCommand.bind(debug);
    debug.sendCommand = (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") log.push(`scale ${params.scale}`);
      return send(method, params);
    };
    manager.setBounds("s", { x: 0, y: 0, width: 320, height: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["scale 0.25", "bounds 320x200"]);

    log.length = 0;
    manager.setBounds("s", { x: 0, y: 0, width: 320, height: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["bounds 320x200"]);
  });

  test("a shown fixed tab renders at the display's real pixel ratio; hidden tabs and agent screenshots stay at CSS pixels", async () => {
    let ratio = 2;
    const { manager, moveWindow, views } = makeHarness({ scaleFactor: () => ratio });
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    const debug = views[0].webContents.debugger;
    const overrides = () => debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride");

    await manager.callTool("s", "browser_snapshot", {});
    expect(overrides().at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await manager.resizeTab(tab, { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overrides().at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, scale: 0.5, dontSetVisibleSize: true });
    expect(tab.viewportOverride).toBe("1280x800@0.5*2 in 640x400");

    await manager.callTool("s", "browser_take_screenshot", {});
    expect(debug.commands.filter((c) => c.method === "Page.captureScreenshot").at(-1).params.clip).toEqual({ x: 0, y: 0, width: 1280, height: 800, scale: 0.5 });

    const sent = overrides().length;
    ratio = 1;
    moveWindow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overrides()).toHaveLength(sent + 1);
    expect(overrides().at(-1).params.deviceScaleFactor).toBe(1);

    moveWindow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overrides()).toHaveLength(sent + 1);
  });

  test("a divider drag pushes no state and persists nothing per frame — one push once the rect settles", async () => {
    const pending = new Map();
    let nextTimer = 1;
    const timers = {
      set: (fn, ms) => { const id = nextTimer++; pending.set(id, { fn, ms }); return id; },
      clear: (id) => pending.delete(id),
    };
    const fire = () => { const due = [...pending.values()]; pending.clear(); for (const { fn } of due) fn(); };
    const saves = [];
    const tabStore = { load: () => null, save: (doc) => saves.push(doc), flushSync: () => {} };
    const { manager, messages } = makeHarness({ timers, tabStore });
    await manager.createTab("s", "https://one.example/");
    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pushes = () => messages.filter((message) => message.channel === "telar:browser:state");
    messages.length = 0;
    saves.length = 0;
    for (const width of [620, 600, 580, 560, 540]) {
      manager.setBounds("s", { x: 0, y: 0, width, height: 400 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pushes()).toHaveLength(0);
    expect(saves).toHaveLength(0);

    expect(pending.size).toBe(1);
    expect([...pending.values()][0].ms).toBeGreaterThan(0);
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].payload.presentation).toMatchObject({ bounds: { width: 540, height: 400 }, scale: 540 / 1280 });

    expect(saves).toHaveLength(0);

    manager.setBounds("s", { x: 0, y: 0, width: 540, height: 400 });
    expect(pending.size).toBe(0);

    manager.setBounds("s", { x: 0, y: 0, width: 500, height: 400 });
    expect(pending.size).toBe(1);
    manager.emitState("s");
    expect(pending.size).toBe(0);
  });

  test("a bounds-only change re-runs geometry for the shown tab alone — hidden tabs are not touched", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.createTab("s", "https://two.example/");
    await manager.createTab("other", "https://three.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = manager.activeTab("s");
    const hidden = manager.tabs.filter((tab) => tab !== shown);
    expect(hidden).toHaveLength(2);
    const runs = new Map();
    const original = manager.applyGeometry.bind(manager);
    manager.applyGeometry = (tab) => { runs.set(tab.id, (runs.get(tab.id) || 0) + 1); return original(tab); };
    const hiddenCommands = hidden.map((tab) => tab.view.webContents.debugger.commands.length);
    const hiddenVisibility = views.filter((view) => view !== shown.view).map((view) => { const calls = []; const set = view.setVisible.bind(view); view.setVisible = (value) => { calls.push(value); set(value); }; return calls; });
    for (const width of [600, 560, 520]) manager.setBounds("s", { x: 0, y: 0, width, height: 400 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs.get(shown.id)).toBe(3);
    for (const tab of hidden) expect(runs.get(tab.id)).toBeUndefined();
    expect(hidden.map((tab) => tab.view.webContents.debugger.commands.length)).toEqual(hiddenCommands);
    expect(hiddenVisibility.flat()).toEqual([]);
    expect(shown.view.bounds).toEqual({ x: 0, y: 0, width: 520, height: 400 });
  });

  test("a shown fixed tab with no debugger yet is placed first — its attach must not delay the first show", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    tab.viewportMode = "fixed";
    tab.debuggerReady = false;
    const view = views[0];
    const log = [];
    const setBounds = view.setBounds.bind(view);
    view.setBounds = (rect) => { log.push("bounds"); setBounds(rect); };
    const send = view.webContents.debugger.sendCommand.bind(view.webContents.debugger);
    view.webContents.debugger.sendCommand = (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") log.push("scale");
      return send(method, params);
    };
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    expect(log[0]).toBe("bounds");
    expect(log).toContain("scale");
  });

  test("a resize (agent tool or toolbar) reflows the page, marks earlier snapshots stale, and is remembered per tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.createTab("s", "https://two.example/");
    await manager.callTool("s", "browser_snapshot", {});
    const resized = await manager.callTool("s", "browser_resize", { preset: "phone" });
    expect(resized.isError).toBeFalsy();
    expect(textOf(resized)).toContain("390×844");
    expect(manager.state("s").tabs.map((tab) => tab.viewport)).toEqual([

      { width: 1280, height: 800, preset: "default", mode: "fit" },
      { width: 390, height: 844, preset: "iphone-12-pro", mode: "fixed" },
    ]);
    const debug = views[1].webContents.debugger;
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 390, height: 844 });

    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("resized");

    const state = await manager.action("s", { action: "resize", index: 0, width: 1000, height: 700 });
    expect(state.tabs[0].viewport).toEqual({ width: 1000, height: 700, preset: null, mode: "fixed" });
    expect(state.tabs[1].viewport).toEqual({ width: 390, height: 844, preset: "iphone-12-pro", mode: "fixed" });

    await manager.callTool("s", "browser_resize", { width: 768 });
    expect(manager.state("s").tabs[1].viewport).toEqual({ width: 768, height: 844, preset: null, mode: "fixed" });
    await manager.callTool("s", "browser_resize", { orientation: "landscape" });
    expect(manager.state("s").tabs[1].viewport).toEqual({ width: 844, height: 768, preset: null, mode: "fixed" });
  });
});

describe("the cockpit's own zoom — the panel publishes CSS pixels, the view takes window pixels (#895)", () => {
  test("a published rect is placed scaled by the cockpit's zoom, and unscaled at zoom 1", async () => {
    const { manager, setCockpitZoom, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    setCockpitZoom(0.9);
    manager.setBounds("s", { x: 100, y: 50, width: 400, height: 300 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 90, y: 45, width: 360, height: 270 });

    expect(manager.bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 });
    expect(manager.state("s").presentation).toMatchObject({ rect: { x: 100, y: 50, width: 400, height: 300 } });

    setCockpitZoom(1);
    manager.setBounds("s", { x: 100, y: 50, width: 400, height: 300 });
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  test("a zoom change re-places the view on its own — no new bounds publish", async () => {
    const { manager, setCockpitZoom, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 100, y: 50, width: 400, height: 300 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 });

    setCockpitZoom(0.9);
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 90, y: 45, width: 360, height: 270 });
    expect(manager.bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  test("a fit tab adopts the stage in WINDOW pixels — the size the page is really laid out for", async () => {
    const { manager, setCockpitZoom } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    setCockpitZoom(0.9);
    manager.setBounds("s", { x: 0, y: 0, width: 400, height: 300 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 360, height: 270 });
  });

  test("a fixed tab's emulation scale carries the zoom, so the page fills the view it is given", async () => {
    const { manager, setCockpitZoom, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    setCockpitZoom(0.9);
    await manager.resizeTab(tab, { preset: "phone" });
    await tab.geometry.queue;

    expect(views[0].bounds).toEqual({ x: 204, y: 0, width: 167, height: 360 });
    const last = views[0].webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    expect(last.params).toMatchObject({ width: 390, height: 844 });

    expect(Math.abs(last.params.scale - (400 / 844) * 0.9)).toBeLessThan(0.001);
  });
});

describe("fit-to-panel viewport mode", () => {
  test("fit follows the visible stage at scale 1, keeps the last seen size while hidden, and returns to fixed with the size it had", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await manager.resizeTab(tab, { mode: "fit" });
    expect(manager.state("s").tabs[0].viewport).toEqual({ width: 640, height: 400, preset: null, mode: "fit" });
    expect(manager.state("s").presentation).toMatchObject({ scale: 1, rect: { x: 0, y: 0, width: 640, height: 400 } });
    const debug = views[0].webContents.debugger;

    expect(debug.commands.at(-1).method).toBe("Emulation.clearDeviceMetricsOverride");
    expect(tab.viewportOverride).toBe("native");

    await manager.callTool("s", "browser_snapshot", {});
    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 900, height: 500 });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 500 });

    manager.setBounds("s", { x: 0, y: 0, width: 880, height: 480 });
    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("resized");

    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 900, height: 500 });
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 900, height: 500, deviceScaleFactor: 1, mobile: false });

    manager.setBounds("s", { x: 0, y: 0, width: 500, height: 300 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 500, height: 300 });

    await manager.resizeTab(tab, { mode: "fixed" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    expect(manager.state("s").tabs[0].viewport).toEqual({ width: 500, height: 300, preset: null, mode: "fixed" });

    await manager.resizeTab(tab, { mode: "fit" });
    manager.setBounds("s", { x: 0, y: 0, width: 120, height: 90 });
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 640, height: 400 });
  });

  test("the mode is remembered per tab and survives a restore", async () => {
    const writes = [];
    const store = { load: () => null, save: (doc) => writes.push(doc), flushSync: () => {} };
    const views = [];
    let nextId = 1;
    const window = { isDestroyed: () => false, webContents: { send: () => {} }, contentView: { addChildView: () => {}, removeChildView: () => {} } };
    const manager = new DesktopBrowserManager(window, { createId: () => `tab-${nextId++}`, createView: () => { const view = new FakeView(); views.push(view); return view; }, wait: async () => {}, tabStore: store });
    manager.ensureAutoRelease = () => {};
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await manager.resizeTab(manager.activeTab("s"), { mode: "fit" });
    const doc = writes.at(-1);
    expect(doc.scopes.s.tabs[0]).toMatchObject({ viewport: { width: 640, height: 400 }, viewportMode: "fit" });

    const restored = new DesktopBrowserManager(window, { createId: () => "x", createView: () => new FakeView(), wait: async () => {}, profiles: manager.profiles, tabStore: { load: () => doc, save: () => {}, flushSync: () => {} } });
    restored.ensureAutoRelease = () => {};
    expect(restored.state("s").tabs[0].viewport).toEqual({ width: 640, height: 400, preset: null, mode: "fit" });
  });

  test("browser_resize {mode: \"fit\"} on a fixed tab puts it back in fit — native bounds, no emulation — and says so", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const fixed = await manager.callTool("s", "browser_resize", { preset: "default" });
    expect(textOf(fixed)).toContain("1280×800 (default)");
    expect(manager.state("s").tabs[0].viewport).toEqual({ width: 1280, height: 800, preset: "default", mode: "fixed" });
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");

    const back = await manager.callTool("s", "browser_resize", { mode: "fit" });
    expect(back.isError).toBeFalsy();
    expect(textOf(back)).toContain("640×400 (fit to panel");
    expect(manager.state("s").tabs[0].viewport).toEqual({ width: 640, height: 400, preset: null, mode: "fit" });
    expect(manager.state("s").presentation).toMatchObject({ mode: "fit", scale: 1, rect: { x: 0, y: 0, width: 640, height: 400 } });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
    expect(tab.viewportOverride).toBe("native");
    expect(views[0].webContents.debugger.commands.at(-1).method).toBe("Emulation.clearDeviceMetricsOverride");
  });
});

describe("a fixed tab's view is exactly the emulated page — bounds and emulation cannot disagree, and the page is centred", () => {
  function expectAgreed(view, rect) {
    expect(view.bounds).toEqual(rect);
    const last = view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    const scale = last.params.scale ?? 1;
    expect({ width: Math.round(last.params.width * scale), height: Math.round(last.params.height * scale) }).toEqual({ width: rect.width, height: rect.height });
  }

  test("through fit → fixed, the rail-reserved stage, a preset change and a cockpit zoom", async () => {
    const { manager, setCockpitZoom, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    const view = views[0];

    manager.setBounds("s", { x: 12, y: 40, width: 858, height: 790 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;

    expect(view.bounds).toEqual({ x: 12, y: 40, width: 858, height: 790 });
    expect(tab.viewportOverride).toBe("native");

    await manager.resizeTab(tab, { preset: "default" });
    await tab.geometry.queue;

    expectAgreed(view, { x: 12, y: 167, width: 858, height: 536 });
    expect(manager.state("s").presentation).toMatchObject({ mode: "fixed", zoom: "fit", rect: { x: 12, y: 167, width: 858, height: 536 } });
    expect(Math.abs(manager.state("s").presentation.scale - 858 / 1280)).toBeLessThan(1e-9);

    manager.setBounds("s", { x: 12, y: 40, width: 846, height: 778 });
    await tab.geometry.queue;
    expectAgreed(view, { x: 12, y: 164, width: 846, height: 529 });

    await manager.resizeTab(tab, { preset: "phone" });
    await tab.geometry.queue;
    expectAgreed(view, { x: 255, y: 40, width: 360, height: 778 });

    await manager.resizeTab(tab, { preset: "default" });
    setCockpitZoom(0.9);
    await tab.geometry.queue;
    expectAgreed(view, { x: 11, y: 148, width: 761, height: 476 });
  });

  test("a hidden fixed tab is emulated at its own size, and shown again in a taller stage it is centred, agreed", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    const view = views[0];
    await manager.resizeTab(tab, { preset: "default" });

    expect(view.bounds).toBeNull();
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 600 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expectAgreed(view, { x: 0, y: 100, width: 640, height: 400 });
    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expectAgreed(view, { x: 0, y: 100, width: 640, height: 400 });
  });
});

describe("a drag on the device frame relays the page out live, and only the release is remembered", () => {
  test("live frames move the view and emit nothing; the release emits once against the size the drag started at", async () => {
    const { manager, messages, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 1000, height: 900 });
    await manager.setVisible("s", true);
    await manager.resizeTab(tab, { width: 600, height: 500 });
    await tab.geometry.queue;
    const pushes = () => messages.filter((message) => message.channel === "telar:browser:state").length;
    const before = pushes();
    const generation = tab.generation;

    expect(await manager.action("s", { action: "resize", width: 640, height: 500, live: true })).toBeNull();
    await manager.action("s", { action: "resize", width: 700, height: 500, live: true });
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 150, y: 200, width: 700, height: 500 });
    expect(pushes()).toBe(before);

    expect(tab.generation).toBeGreaterThan(generation);

    await manager.action("s", { action: "resize", width: 700, height: 500 });
    expect(pushes()).toBe(before + 1);
    expect(manager.viewportInfo(tab)).toMatchObject({ width: 700, height: 500, mode: "fixed" });
    expect(tab.liveResizeFrom).toBeUndefined();
  });

  test("an abandoned drag commits the start size: the view goes back and nothing is said to have changed", async () => {
    const { manager, messages, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 1000, height: 900 });
    await manager.setVisible("s", true);
    await manager.resizeTab(tab, { width: 600, height: 500 });
    await tab.geometry.queue;
    const pushes = () => messages.filter((message) => message.channel === "telar:browser:state").length;
    const before = pushes();

    await manager.action("s", { action: "resize", width: 800, height: 700, live: true });
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 100, y: 100, width: 800, height: 700 });
    await manager.action("s", { action: "resize", width: 600, height: 500 });
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 200, y: 200, width: 600, height: 500 });
    expect(pushes()).toBe(before);
  });

  test("a zoom changes how the page is shown, never its layout", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 1000, height: 900 });
    await manager.setVisible("s", true);
    await manager.resizeTab(tab, { width: 600, height: 500 });
    await manager.action("s", { action: "resize", zoom: 0.5 });
    await tab.geometry.queue;
    expect(views[0].bounds).toEqual({ x: 350, y: 325, width: 300, height: 250 });
    expect(manager.viewportInfo(tab)).toMatchObject({ width: 600, height: 500 });
    expect(manager.state("s").presentation).toMatchObject({ zoom: 0.5, scale: 0.5 });
    await expect(manager.action("s", { action: "resize", zoom: 3 })).rejects.toThrow(/Unknown zoom/);
  });
});

describe("a fixed page's widget is the view's size, never the override's", () => {
  const STAGE = { x: 8, y: 120, width: 975, height: 794 };

  async function fixedInTallStage(zoom = 1) {
    const harness = makeHarness();
    const { manager, views, setCockpitZoom } = harness;
    if (zoom !== 1) setCockpitZoom(zoom);
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    await manager.resizeTab(tab, { preset: "default" });
    manager.setBounds("s", STAGE);
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    const debug = views[0].webContents.debugger;
    const last = (method) => debug.commands.filter((c) => c.method === method).at(-1);
    const count = (method) => debug.commands.filter((c) => c.method === method).length;
    return { ...harness, tab, debug, last, count };
  }

  test("shown: the override leaves the widget alone and the widget is pinned to the view's bounds", async () => {
    const { manager, views, last } = await fixedInTallStage();
    const { rect } = manager.state("s").presentation;

    expect(rect).toEqual({ x: 8, y: 212, width: 975, height: 609 });
    expect(views[0].bounds).toEqual(rect);
    expect(last("Emulation.setDeviceMetricsOverride").params).toMatchObject({ width: 1280, height: 800, dontSetVisibleSize: true });
    expect(last("Emulation.setVisibleSize").params).toEqual({ width: 975, height: 609 });
  });

  test("under the cockpit's zoom the widget is the view's own pixels, the same numbers setBounds was given", async () => {
    const { views, last } = await fixedInTallStage(1.25);
    const { width, height } = views[0].bounds;
    expect({ width, height }).toEqual({ width: 1219, height: 761 });
    expect(last("Emulation.setVisibleSize").params).toEqual({ width, height });
  });

  test("hidden, the widget takes the full viewport again; shown, it is pinned back to the view", async () => {
    const { manager, tab, last, count } = await fixedInTallStage();
    const pinned = count("Emulation.setVisibleSize");
    await manager.setVisible("s", false);
    await tab.geometry.queue;

    expect(last("Emulation.setDeviceMetricsOverride").params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(count("Emulation.setVisibleSize")).toBe(pinned);
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(last("Emulation.setDeviceMetricsOverride").params).toMatchObject({ dontSetVisibleSize: true });
    expect(count("Emulation.setVisibleSize")).toBe(pinned + 1);
    expect(last("Emulation.setVisibleSize").params).toEqual({ width: 975, height: 609 });
  });

  test("a new panel size re-pins the widget even where the fit scale would round the same", async () => {
    const { manager, tab, last } = await fixedInTallStage();
    manager.setBounds("s", { ...STAGE, width: 800 });
    await tab.geometry.queue;
    expect(last("Emulation.setVisibleSize").params).toEqual({ width: 800, height: 500 });
    expect(tab.viewportOverride).toBe("1280x800@0.625 in 800x500");
  });

  test("the frozen frame is cropped to the view's own pixels and painted back at the fitted rect", async () => {
    const { manager, views } = await fixedInTallStage(1.25);
    const frame = await manager.freezeView("s");
    expect(views[0].webContents.captures.at(-1).rect).toEqual({ x: 0, y: 0, width: 1219, height: 761 });

    expect(frame.rect).toEqual({ x: 8, y: 212, width: 975, height: 609 });
  });
});
