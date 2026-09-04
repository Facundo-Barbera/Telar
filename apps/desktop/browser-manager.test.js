const { EventEmitter } = require("node:events");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager, normalizeUrl } = require("./browser-manager");

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.commands = [];
  }

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  async sendCommand(method, params) {
    this.commands.push({ method, params });
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "root",
            role: { value: "RootWebArea" },
            name: { value: "Fixture" },
          },
          {
            nodeId: "button",
            parentId: "root",
            backendDOMNodeId: 17,
            role: { value: "button" },
            name: { value: "Count 0" },
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "button-object" } };
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: { x: 120, y: 80, width: 80, height: 32 } } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: "cG5n" };
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.debugger = new FakeDebugger();
    this.url = "about:blank";
    this.title = "New tab";
    this.destroyed = false;
    this.loadGate = null;
    this.inputEvents = [];
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  async loadURL(url) {
    this.emit("did-start-loading");
    if (this.loadGate) await this.loadGate;
    this.url = url;
    this.title = "Fixture";
    this.emit("did-navigate");
    this.emit("did-stop-loading");
  }

  reload() {}

  sendInputEvent(event) {
    this.inputEvents.push(event);
  }

  isDestroyed() {
    return this.destroyed;
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView {
  constructor() {
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.bounds = null;
  }

  setBackgroundColor() {}

  setVisible(visible) {
    this.visible = visible;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }
}

function makeHarness(options = {}) {
  const views = [];
  const messages = [];
  const waits = [];
  const children = new Set();
  let nextId = 1;
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => messages.push({ channel, payload }),
    },
    contentView: {
      addChildView: (view) => children.add(view),
      removeChildView: (view) => children.delete(view),
    },
  };
  const manager = new DesktopBrowserManager(window, {
    createId: () => `tab-${nextId++}`,
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view;
    },
    wait: options.wait || (async (milliseconds) => {
      waits.push(milliseconds);
    }),
    maxLiveViews: options.maxLiveViews,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onControlChanged ? { onControlChanged: options.onControlChanged } : {}),
  });
  return { children, manager, messages, views, waits };
}

function textOf(result) {
  return (result.content || []).map((part) => part.text || "").join("\n");
}

describe("normalizeUrl", () => {
  test("normalizes local addresses without accepting non-web protocols", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(() => normalizeUrl("file:///tmp/example.html")).toThrow(
      "only opens http and https URLs",
    );
  });
});

describe("DesktopBrowserManager", () => {
  test("owns tab visibility and bounds without an Electron process", async () => {
    const { children, manager, views } = makeHarness();

    await manager.createTab("session-a", "localhost:3000");
    manager.setBounds("session-a", { x: 10.4, y: 20.6, width: 800.2, height: 600.8 });
    await manager.setVisible("session-a", true);

    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ id: "tab-1", url: "http://localhost:3000/", active: true }),
    ]);
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 10, y: 21, width: 800, height: 601 });
    expect(children.size).toBe(1);

    manager.destroy();
    expect(children.size).toBe(0);
    expect(views[0].webContents.destroyed).toBe(true);
  });

  test("hides and hibernates the visible scope safely during a renderer reload", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    await manager.setVisible("session-a", true);

    expect(() => manager.hideVisibleScope()).not.toThrow();
    expect(manager.visibleScopeKey).toBeNull();
    expect(children.size).toBe(0);
    expect(views[0].webContents.destroyed).toBe(true);
    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ url: "https://example.com/", active: true }),
    ]);
  });

  test("conversation switches hide without destroying the session browser", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://a.example");
    await manager.setVisible("session-a", true);

    await manager.setVisible("session-a", false);
    expect(views[0].visible).toBe(false);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(children.size).toBe(1);

    await manager.createTab("session-b", "https://b.example");
    await manager.setVisible("session-b", true);
    expect(textOf(await manager.callTool("session-a", "browser_tabs", { action: "list" })))
      .toContain("https://a.example/");

    await manager.setVisible("session-b", false);
    await manager.setVisible("session-a", true);
    expect(views[0].visible).toBe(true);
    expect(views[0].webContents.destroyed).toBe(false);
  });

  test("returning to a budget-hibernated conversation recreates its rendered view", async () => {
    const { children, manager, views } = makeHarness({ maxLiveViews: 1 });
    await manager.createTab("session-a", "https://a.example");
    await manager.createTab("session-b", "https://b.example");
    expect(views[0].webContents.destroyed).toBe(true);

    await manager.setVisible("session-a", true);
    expect(children.size).toBe(1);
    expect(views[2].visible).toBe(true);
    expect(views[2].webContents.getURL()).toBe("https://a.example/");
  });

  test("the live-view budget cannot hibernate a background browser tool call", async () => {
    let releaseWait;
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    const { manager, views } = makeHarness({
      maxLiveViews: 1,
      wait: async () => {
        enteredWait();
        await gate;
      },
    });
    await manager.createTab("session-a", "https://a.example");
    await manager.callTool("session-a", "browser_snapshot");
    const click = manager.callTool("session-a", "browser_click", {
      target: "e1",
      element: "Count 0 button",
    });
    await waiting;

    await manager.setVisible("session-a", false);
    await manager.createTab("session-b", "https://b.example");
    expect(views[0].webContents.destroyed).toBe(false);

    releaseWait();
    expect((await click).isError).not.toBe(true);
  });

  test("does not close a view while navigation is still loading", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a");
    await manager.setVisible("session-a", true);
    let finishLoad;
    views[0].webContents.loadGate = new Promise((resolve) => { finishLoad = resolve; });

    const navigation = manager.action("session-a", {
      action: "navigate",
      url: "https://www.youtube.com/",
    });
    manager.releaseScope("session-a");

    expect(views[0].webContents.destroyed).toBe(false);
    expect(views[0].visible).toBe(false);

    finishLoad();
    await navigation;

    expect(views[0].webContents.destroyed).toBe(true);
    expect(children.size).toBe(0);
    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ url: "https://www.youtube.com/", active: true }),
    ]);
  });

  test("exposes accessibility refs and preserves cursor timing around clicks", async () => {
    const { manager, messages, views, waits } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    const snapshot = await manager.callTool("session-a", "browser_snapshot");
    expect(textOf(snapshot)).toContain('button "Count 0" [ref=e1]');

    const clicked = await manager.callTool("session-a", "browser_click", {
      target: "e1",
      element: "Count 0 button",
    });

    expect(clicked.isError).not.toBe(true);
    expect(waits).toEqual([160, 40]);
    expect(
      messages
        .filter((message) => message.channel === "telar:browser:pointer")
        .map((message) => message.payload.phase),
    ).toEqual(["move", "click"]);
    expect(
      views[0].webContents.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params.type),
    ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  test("returns a bounded tool error for stale accessibility refs", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "about:blank");

    const result = await manager.callTool("session-a", "browser_click", { target: "e404" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Take a fresh browser_snapshot first");
  });

  test("never exposes tabs across browser session scopes", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://a.example");

    expect(textOf(await manager.callTool("session-b", "browser_tabs", { action: "list" })))
      .toBe("No browser tabs are open in this session.");
    const denied = await manager.callTool("session-b", "browser_snapshot");
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("Open a browser tab");

    await manager.createTab("session-b", "https://b.example");
    expect(manager.state("session-a").tabs.map((tab) => tab.url)).toEqual(["https://a.example/"]);
    expect(manager.state("session-b").tabs.map((tab) => tab.url)).toEqual(["https://b.example/"]);
  });

  test("hibernates inactive views, bounds live renderers, and adopts draft scopes", async () => {
    const { children, manager, views } = makeHarness({ maxLiveViews: 2 });
    await manager.createTab("draft", "https://one.example");
    await manager.createTab("other", "https://two.example");
    await manager.createTab("third", "https://three.example");

    expect(children.size).toBe(2);
    expect(views.filter((view) => !view.webContents.destroyed)).toHaveLength(2);
    manager.adoptScope("draft", "session-a");
    expect(manager.state("draft").tabs).toHaveLength(0);
    expect(manager.state("session-a").tabs.map((tab) => tab.url)).toEqual(["https://one.example/"]);

    manager.releaseScope("session-a", true);
    expect(manager.state("session-a").tabs).toHaveLength(0);
  });
});

describe("desktop shell development contracts", () => {
  test("uses the Telar icon in an unpackaged Electron run", () => {
    const source = readFileSync(path.join(__dirname, "main.js"), "utf8");

    // The dev shell PREFERS the amber loom (icon-dev.png) and falls back to
    // the production icon — see developmentIconPath in main.js.
    expect(source).toContain('["icon-dev.png", "icon.png"]');
    expect(source).toContain('path.join(__dirname, "build", name)');
    expect(source).toContain("app.dock.setIcon(icon)");
    expect(source).toContain("...(icon ? { icon } : {})");
    expect(existsSync(path.join(__dirname, "build", "icon.png"))).toBe(true);
  });

  test("shares the normal web development state unless explicitly overridden", () => {
    const runner = readFileSync(path.join(__dirname, "dev-runner.js"), "utf8");

    expect(runner).not.toContain(".telar-desktop-dev");
    expect(runner).toContain("{ cwd: repoDir, env: sharedEnv }");
    expect(runner).toContain("...process.env");
  });

  test("hides native browser views before the Telar renderer reloads", () => {
    const source = readFileSync(path.join(__dirname, "main.js"), "utf8");

    expect(source).toContain('win.webContents.on("did-start-loading"');
    // Per-window manager, captured in createWindow's closure — the global
    // would point at the WRONG manager during a translucency window rebuild.
    expect(source).toContain("manager.hideVisibleScope()");
  });

  test("isolates E2E Electron state without disabling production's instance lock", () => {
    const source = readFileSync(path.join(__dirname, "main.js"), "utf8");
    const e2e = readFileSync(path.join(__dirname, "desktop-e2e.js"), "utf8");

    expect(source).toContain('app.setPath("userData", E2E_USER_DATA)');
    expect(source).toContain("app.requestSingleInstanceLock()");
    expect(e2e).toContain("TELAR_DESKTOP_E2E_USER_DATA: desktopUserData");
  });
});

describe("the shared-browser control model (§6) — control is PER TAB", () => {
  function controlHarness() {
    const clock = { t: 1_000_000 };
    const changes = [];
    const harness = makeHarness({
      now: () => clock.t,
      onControlChanged: (change) => changes.push(change),
    });
    return { ...harness, clock, changes };
  }

  test("an agent mutation claims the ACTIVE tab; reads and tab-selects never claim anything", async () => {
    const { manager, changes } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    expect(manager.state("s").tabs[0].controller).toBe("agent");
    expect(manager.state("s").tabs[0].openedBy).toBe("agent");
    await manager.callTool("s", "browser_tabs", { action: "list" });
    await manager.callTool("s", "browser_take_screenshot", {});
    expect(changes.map((change) => change.controller)).toEqual(["agent"]);
    expect(changes[0].tabId).toBe(manager.state("s").tabs[0].id);
  });

  test("the human taking tab 1 does not stop the agent in tab 0 — refusal names the held tab", async () => {
    const { manager, clock } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    clock.t += 10_000;
    // The human grabs tab 1 (the current one, just opened by the agent).
    expect(manager.noteHumanInput("s")).toBe(true);
    expect(manager.state("s").tabs[1].controller).toBe("human");
    expect(manager.state("s").tabs[0].controller).toBe("agent");

    // Mutating the CURRENT (held) tab: refused, naming it.
    const refused = await manager.callTool("s", "browser_type", { target: "e1", text: "x" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("took tab 1");
    // Closing the held tab: refused too.
    const closeRefused = await manager.callTool("s", "browser_tabs", { action: "close", index: 1 });
    expect(closeRefused.isError).toBe(true);

    // The agent moves to ITS tab and keeps working.
    clock.t += 10_000;
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    const resumed = await manager.callTool("s", "browser_navigate", { url: "https://one.example/next" });
    expect(resumed.isError).toBeUndefined();
    // And may still READ the human's tab by tabId without switching current.
    const looked = await manager.callTool("s", "browser_take_screenshot", { tabId: 1 });
    expect(looked.isError).toBeUndefined();
    expect(manager.state("s").tabs[0].active).toBe(true);
  });

  test("input during or right after an agent action is attributed to the AGENT, not the human", async () => {
    const { manager, clock } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 100;
    expect(manager.noteHumanInput("s")).toBe(false);
    expect(manager.state("s").tabs[0].controller).toBe("agent");
    // The cockpit's own chrome is human BY CONSTRUCTION and skips the window.
    expect(manager.noteHumanInput("s", { force: true })).toBe(true);
    expect(manager.state("s").tabs[0].controller).toBe("human");
  });

  test("a takeover MID-ACTION turns the in-flight result into the takeover sentence", async () => {
    const { manager, views } = controlHarness();
    await manager.createTab("s", "localhost:3000");
    let release;
    views[0].webContents.loadGate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.noteHumanInput("s", { force: true });
    release();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("took tab 0");
  });

  test("handback is explicit and per tab; without a tabId every held tab returns", async () => {
    const { manager, clock, changes } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    const state = manager.handBack("s");
    expect(state.tabs[0].controller).toBe("agent");
    expect(changes.map((change) => change.controller)).toEqual(["agent", "human", "agent"]);
    const resumed = await manager.callTool("s", "browser_navigate", { url: "https://example.org" });
    expect(resumed.isError).toBeUndefined();
  });

  test("the cockpit's URL bar takes the active tab; a human + opens a HUMAN tab; the agent's back-nav takes nothing away", async () => {
    const { manager, clock } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    await manager.action("s", { action: "navigate", url: "https://example.org" });
    expect(manager.state("s").tabs[0].controller).toBe("human");
    await manager.action("s", { action: "new" });
    const tabs = manager.state("s").tabs;
    expect(tabs[1].openedBy).toBe("human");
    expect(tabs[1].controller).toBe("human");
    manager.handBack("s");
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    await manager.callTool("s", "browser_navigate_back", {});
    expect(manager.state("s").tabs[0].controller).toBe("agent");
  });

  test("the tab cap refuses the 13th tab with a sentence; closing the last tab leaves one blank", async () => {
    const { manager } = controlHarness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("s", "about:blank");
    const overCap = await manager.callTool("s", "browser_tabs", { action: "new" });
    expect(overCap.isError).toBe(true);
    expect(textOf(overCap)).toContain("Tab limit reached");

    const solo = controlHarness();
    await solo.manager.createTab("t", "https://example.com");
    solo.manager.closeTab("t", 0, "human");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tabs = solo.manager.state("t").tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe("about:blank");
  });

  test("list output carries controller and opener per tab, in the {…} suffix the engine parses", async () => {
    const { manager, clock } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(textOf(listed)).toMatch(/\{controller=human, opened-by=agent\}/);
  });

  test("destroying a scope returns its tabs to idle; hibernation keeps per-tab control", async () => {
    const { manager, clock, changes } = controlHarness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    manager.releaseScope("s", false);
    expect(manager.state("s").tabs[0].controller).toBe("human");
    manager.releaseScope("s", true);
    expect(changes.at(-1).controller).toBe("idle");
  });

  test("human input reported from a tab's own webContents flips THAT tab", async () => {
    const { manager, views, clock } = controlHarness();
    await manager.createTab("s", "localhost:3000");
    await manager.createTab("s", "https://example.com");
    clock.t += 10_000;
    manager.noteHumanInputFromWebContents(views[0].webContents);
    expect(manager.state("s").tabs[0].controller).toBe("human");
    // Tab 1 keeps ITS controller (the agent claimed it by opening it).
    expect(manager.state("s").tabs[1].controller).toBe("agent");
    manager.noteHumanInputFromWebContents({ unknown: true });
  });
});
