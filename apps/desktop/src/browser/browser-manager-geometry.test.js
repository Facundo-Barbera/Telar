const { describe, expect, test } = require("bun:test");

const { makeHarness } = require("../../test/browser-manager-harness");
describe("the geometry pipeline — bounds and emulation are serialized per tab, latest wins", () => {
  test("a preset change places the view for the NEW size and re-asserts it after the emulation settles — no stale bounds from an older run", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const view = views[0];
    const debug = view.webContents.debugger;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = debug.sendCommand.bind(debug);
    let gated = 0;
    debug.sendCommand = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride" && gated++ === 0) await gate;
      return original(method, params);
    };
    const tab = manager.activeTab("s");

    const resize = manager.resizeTab(tab, { preset: "phone" });
    manager.setBounds("s", { x: 0, y: 0, width: 400, height: 400 });
    release();
    await resize;
    await tab.geometry.queue;

    expect(view.bounds).toEqual({ x: 107, y: 0, width: 185, height: 400 });
    expect(view.visible).toBe(true);
    const last = debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    expect(last.params).toMatchObject({ width: 390, height: 844 });
    expect(Math.abs(last.params.scale - 400 / 844)).toBeLessThan(0.001);
  });

  test("rapid preset switches coalesce: one run in flight, one scheduled, the final state is the last request", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const tab = manager.activeTab("s");
    await Promise.all([
      manager.resizeTab(tab, { preset: "phone" }),
      manager.resizeTab(tab, { preset: "tablet" }),
      manager.resizeTab(tab, { preset: "laptop" }),
      manager.resizeTab(tab, { width: 1000, height: 700 }),
    ]);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 1000, height: 700 });
    const view = views[0];

    expect(view.bounds).toEqual({ x: 34, y: 0, width: 571, height: 400 });
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 1000, height: 700 });
  });

  test("a republish of UNCHANGED bounds still re-places the view (the renderer's self-heal path)", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const view = views[0];
    view.bounds = { x: 9, y: 9, width: 9, height: 9 };
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.activeTab("s").geometry.queue;
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });

  test("a MOVE at the same stage size is one native setBounds and nothing else — no emulation pass, no CDP", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const tab = manager.activeTab("s");
    await tab.geometry.queue;

    const view = views[0];
    const debug = view.webContents.debugger;
    let placements = 0;
    const place = view.setBounds.bind(view);
    view.setBounds = (bounds) => { placements += 1; place(bounds); };
    let syncs = 0;
    const sync = manager.syncFitViewport.bind(manager);
    manager.syncFitViewport = (t) => { syncs += 1; return sync(t); };
    const commandsBefore = debug.commands.length;

    manager.setBounds("s", { x: 20, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    manager.setBounds("s", { x: 40, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;

    expect(placements).toBe(2);
    expect(view.bounds).toEqual({ x: 40, y: 0, width: 640, height: 400 });

    expect(syncs).toBe(0);
    expect(debug.commands.length).toBe(commandsBefore);
  });

  test("a stage that changed SIZE still runs the whole pass", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    await manager.resizeTab(tab, { preset: "phone" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;

    const debug = views[0].webContents.debugger;
    let syncs = 0;
    const sync = manager.syncFitViewport.bind(manager);
    manager.syncFitViewport = (t) => { syncs += 1; return sync(t); };
    const overrides = () => debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length;
    const before = overrides();

    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;

    expect(syncs).toBe(1);
    expect(overrides()).toBe(before + 1);
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 390, height: 844 });
  });
});

describe("the recorded emulation never outlives the real one (#917)", () => {
  async function settledFixedTab() {
    const harness = makeHarness();
    const { manager, views } = harness;
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    await manager.resizeTab(tab, { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    const wc = views[0].webContents;
    const debug = wc.debugger;
    const overrides = () => debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
    return { ...harness, tab, wc, debug, overrides };
  }

  test("suspect 1: a debugger detach forgets the record, so identical bounds re-attach and re-send where the fast path used to skip", async () => {
    const { manager, tab, debug, overrides, views } = await settledFixedTab();
    const before = overrides().length;

    debug.attached = false;
    debug.emit("detach", {}, "target closed");
    expect(tab.debuggerReady).toBe(false);
    expect(tab.viewportOverride).toBeUndefined();
    expect(manager.emulationSettled(tab)).toBe(false);

    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    expect(debug.isAttached()).toBe(true);
    expect(tab.debuggerReady).toBe(true);
    expect(overrides().length).toBe(before + 1);
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });

  test("a detach from the WebContents a tab has already left does not unsettle the new one", async () => {
    const { manager, tab, debug: old, views } = await settledFixedTab();
    manager.hibernateTab(tab);
    await manager.wakeTab(tab);
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(views).toHaveLength(2);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");

    old.emit("detach", {}, "target closed");
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    expect(tab.debuggerReady).toBe(true);
  });

  test("suspect 1: DevTools opening and closing each forget the record and re-send — DevTools clears the device metrics behind the debugger's back", async () => {
    const { manager, tab, wc, overrides, views } = await settledFixedTab();
    const before = overrides().length;
    await manager.action("s", { action: "toggle-devtools" });
    await tab.geometry.queue;
    expect(wc.isDevToolsOpened()).toBe(true);
    expect(overrides().length).toBe(before + 1);
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });

    wc.closeDevTools();
    await tab.geometry.queue;
    expect(overrides().length).toBe(before + 2);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");

    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });

  test("the appearance override rides the same edges: DevTools closing re-sends a dark scheme", async () => {
    const { manager, tab, wc, debug } = await settledFixedTab();
    await manager.action("s", { action: "appearance", scheme: "dark" });
    const media = () => debug.commands.filter((c) => c.method === "Emulation.setEmulatedMedia");
    const before = media().length;
    await manager.action("s", { action: "toggle-devtools" });
    await tab.geometry.queue;
    wc.closeDevTools();
    await tab.geometry.queue;
    expect(media().length).toBe(before + 2);
    expect(media().at(-1).params.features).toEqual([{ name: "prefers-color-scheme", value: "dark" }]);
    expect(tab.colorSchemeApplied).toBe("dark");
  });

  test("suspect 1: a renderer that went away takes the record with it", async () => {
    const { manager, tab, wc, overrides } = await settledFixedTab();
    const before = overrides().length;
    wc.emit("render-process-gone", {}, { reason: "crashed" });
    expect(tab.viewportOverride).toBeUndefined();
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    expect(overrides().length).toBe(before + 1);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
  });

  test("suspect 2: a rejected setDeviceMetricsOverride leaves the record unsettled, so the next pass retries", async () => {
    const { manager, tab, debug, overrides } = await settledFixedTab();
    const original = debug.sendCommand.bind(debug);
    let refusals = 0;
    debug.sendCommand = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride" && refusals++ === 0) throw new Error("Target closed.");
      return original(method, params);
    };

    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;
    expect(refusals).toBe(1);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    expect(manager.emulationSettled(tab)).toBe(false);

    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.375 });
    expect(tab.viewportOverride).toBe("1280x800@0.375 in 480x300");
  });

  test("suspect 3, ruled out: a cockpit zoom change alone re-sends a fixed tab's emulation with the zoom in its scale", async () => {
    const { setCockpitZoom, tab, overrides, views } = await settledFixedTab();
    const before = overrides().length;

    setCockpitZoom(0.9);
    await tab.geometry.queue;
    expect(overrides().length).toBe(before + 1);
    expect(Math.abs(overrides().at(-1).params.scale - 0.45)).toBeLessThan(1e-9);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 576, height: 360 });
    expect(tab.viewportOverride).toBe("1280x800@0.45 in 576x360");
  });

  test("suspect 4, ruled out: a fixed tab hidden and shown again — panel closed, or another tab in front — is re-emulated at the shown scale", async () => {
    const { manager, tab, overrides, views } = await settledFixedTab();

    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(views[0].visible).toBe(false);

    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });

    await manager.createTab("s", "https://two.example/", "human");
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(views[0].visible).toBe(false);
    await manager.action("s", { action: "select", index: 0 });
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });
});

describe("the canvas under the page — opaque once a document is ready, none before", () => {
  const NONE = "#00000000";
  const WHITE = "#ffffff";

  test("a fresh view has no canvas; dom-ready of a real document gives it an opaque white one; a blank tab takes it back", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s");
    const tab = manager.activeTab("s");
    const view = views[0];
    const wc = view.webContents;

    expect(view.canvases).toEqual([NONE]);
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;

    wc.emit("did-start-loading");
    await tab.geometry.queue;
    expect(view.visible).toBe(true);
    wc.url = "https://one.example/";
    wc.emit("did-navigate");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE]);
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE]);
    wc.emit("did-stop-loading");
    await tab.geometry.queue;

    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE]);

    await manager.navigateTab(tab, "https://two.example/");
    expect(view.canvases).toEqual([NONE, WHITE]);
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE]);

    await wc.loadURL("about:blank");
    await tab.geometry.queue;
    expect(view.visible).toBe(false);
    expect(view.canvases).toEqual([NONE, WHITE, NONE]);

    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE, NONE]);

    await wc.loadURL("https://three.example/");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE, NONE, WHITE]);

    wc.emit("render-process-gone");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE, NONE, WHITE, NONE]);
  });

  test("a woken tab's new WebContents starts without a canvas again, until its document is ready", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    await tab.geometry.queue;
    expect(views[0].canvases).toEqual([NONE, WHITE]);
    manager.hibernateTab(tab);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const createView = manager.createView;
    manager.createView = (options) => {
      const view = createView(options);
      view.webContents.loadGate = gate;
      return view;
    };
    const woke = manager.wakeTab(tab);
    await Promise.resolve();
    expect(views[1].canvases).toEqual([NONE]);
    release();
    await woke;
    await tab.geometry.queue;
    expect(views[1].canvases).toEqual([NONE, WHITE]);
  });

  test("a tab in a window of its own keeps its canvas — the page is the whole window there", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    views[0].webContents.emit("dom-ready");
    await tab.geometry.queue;
    await manager.action("s", { action: "preview" });
    await manager.applyGeometry(tab);
    expect(views[0].canvases).toEqual([NONE, WHITE]);
  });
});

describe("bounds are per scope — a stale scope's publish never moves the visible view", () => {
  test("a late setBounds for the session the renderer left does not re-place the shown session's view; it applies when that session is shown again", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("A", "https://a.example/");
    await manager.createTab("B", "https://b.example/");

    manager.setBounds("A", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("A", true);
    await manager.setVisible("A", false);
    manager.setBounds("B", { x: 10, y: 20, width: 900, height: 500 });
    await manager.setVisible("B", true);
    await manager.activeTab("B").geometry.queue;
    expect(views[1].bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });

    manager.setBounds("A", { x: 0, y: 0, width: 300, height: 200 });
    await manager.activeTab("B").geometry.queue;
    expect(manager.bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });
    expect(views[1].bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });
    expect(views[1].visible).toBe(true);
    expect(views[0].visible).toBe(false);

    await manager.setVisible("B", false);
    await manager.setVisible("A", true);
    await manager.activeTab("A").geometry.queue;
    expect(manager.bounds).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  test("a stale setVisible(false) for a scope that is not shown changes nothing", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("A", "https://a.example/");
    await manager.createTab("B", "https://b.example/");
    manager.setBounds("B", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("B", true);
    await manager.setVisible("A", false);
    await manager.activeTab("B").geometry.queue;
    expect(manager.visibleScopeKey).toBe("B");
    expect(views[1].visible).toBe(true);
  });
});

describe("the panel's corner, and the frozen frame a menu opens over", () => {
  async function shown(bounds = {}) {
    const harness = makeHarness();
    await harness.manager.createTab("s", "https://example.com/");
    harness.manager.setBounds("s", { x: 12, y: 40, width: 640, height: 400, ...bounds });
    await harness.manager.setVisible("s", true);
    const tab = harness.manager.activeTab("s");
    await tab.geometry.queue;
    return { ...harness, tab, view: harness.views[0] };
  }

  test("the radius the renderer publishes is written to the view, and only when it changes", async () => {
    const { manager, view } = await shown({ radius: 14 });
    expect(view.radii.at(-1)).toBe(14);

    const written = view.radii.length;
    manager.setBounds("s", { x: 12, y: 40, width: 640, height: 400, radius: 14 });
    await manager.activeTab("s").geometry.queue;
    expect(view.radii.length).toBe(written);

    manager.setBounds("s", { x: 12, y: 40, width: 640, height: 400, radius: 0 });
    await manager.activeTab("s").geometry.queue;
    expect(view.radii.at(-1)).toBe(0);
  });

  test("an older renderer, which publishes no radius at all, leaves the view square", async () => {
    const { view } = await shown();
    expect(view.radii.every((radius) => radius === 0)).toBe(true);
  });

  test("a tab in a window of its own is square — the panel's corner is not its", async () => {
    const { manager, view } = await shown({ radius: 14 });
    expect(view.radii.at(-1)).toBe(14);
    await manager.action("s", { action: "preview" });
    await manager.applyGeometry(manager.scopeTabs("s")[0]);
    expect(view.radii.at(-1)).toBe(0);
  });

  test("the capture finishes while the page is still shown, and the hide follows it", async () => {
    const { manager, tab, view } = await shown({ radius: 14 });
    let release;
    tab.view.webContents.captureGate = new Promise((resolve) => { release = resolve; });

    const freezing = manager.freezeView("s");
    await Promise.resolve();

    expect(tab.view.webContents.captures).toEqual([{ visibleAtCapture: true, rect: { x: 0, y: 0, width: 640, height: 400 } }]);
    expect(view.visible).toBe(true);

    release();
    const frame = await freezing;
    expect(frame).toEqual({
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/png",

      rect: { x: 12, y: 40, width: 640, height: 400 },
    });
    expect(view.visible).toBe(false);
  });

  test("a capture that outruns the ceiling hides plainly, the way it did before the frame existed", async () => {
    const { manager, tab, view } = await shown({ radius: 14 });

    tab.view.webContents.captureGate = new Promise(() => {});
    expect(await manager.freezeView("s")).toBeNull();
    expect(view.visible).toBe(false);
  });

  test("a capture that fails, and one that comes back blank, hide plainly too", async () => {
    const failing = await shown({ radius: 14 });
    failing.tab.view.webContents.captureError = new Error("no frame");
    expect(await failing.manager.freezeView("s")).toBeNull();
    expect(failing.view.visible).toBe(false);

    const empty = await shown({ radius: 14 });
    empty.tab.view.webContents.captureEmpty = true;
    expect(await empty.manager.freezeView("s")).toBeNull();
    expect(empty.view.visible).toBe(false);
  });

  test("a blank tab is never captured — the start page is DOM, and its view is already down", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400, radius: 14 });
    await manager.setVisible("s", true);
    await manager.activeTab("s").geometry.queue;

    expect(await manager.freezeView("s")).toBeNull();
    expect(views[0].webContents.captures).toEqual([]);
    expect(views[0].visible).toBe(false);
  });
});
