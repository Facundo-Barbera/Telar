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
    // The credential probe, per frame: tests set `probeAnswers` to one
    // answer per frame (false = empty, true = filled, null = probe missing,
    // an Error = the frame threw).
    this.probeAnswers = [false];
    const self = this;
    this.mainFrame = {
      get framesInSubtree() {
        return self.probeAnswers.map((answer) => ({
          executeJavaScript: () => {
            if (answer === "__hang__") return new Promise(() => {}); // never settles
            if (answer instanceof Error) return Promise.reject(answer);
            return Promise.resolve(answer);
          },
        }));
      },
    };
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  isLoading() {
    return false;
  }

  // A hidden view's capture path (see DesktopBrowserManager.screenshot):
  // Electron's NativeImage, narrowed to what the manager reads.
  async capturePage() {
    return {
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
      toJPEG: () => Buffer.from("jpg"),
    };
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
    ...(options.rpcTimeoutMs ? { rpcTimeoutMs: options.rpcTimeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onControlChanged ? { onControlChanged: options.onControlChanged } : {}),
    ...(options.onVisited ? { onVisited: options.onVisited } : {}),
  });
  // Most tests do not care about profiles; a scope auto-binds the explicit
  // `none` profile on first tab so they exercise the rest of the manager.
  // The profile boundary itself is covered by its own tests (fail-closed
  // below, plus browser-profiles.test.js and Astra's real-Electron harness).
  const origCreate = manager.createTab.bind(manager);
  manager.createTab = (scopeKey, ...rest) => {
    if (scopeKey && !manager.profileOf(scopeKey)) manager.declareProfile(scopeKey, "none");
    return origCreate(scopeKey, ...rest);
  };
  // The automatic-release loop polls on a real interval; with the harness's
  // immediate-resolve `wait` it would busy-spin. Tests that exercise the loop
  // pass `lifecycle: true` and drive it with a manual clock; the rest keep the
  // old explicit model (privacy ends via resumeFromPrivate/autoRelease).
  if (!options.lifecycle) manager.ensureAutoRelease = () => {};
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
    // FIT IS THE DEFAULT: the page follows the panel, so the view takes the
    // whole 800×601 stage at scale 1 (an explicit preset would letterbox).
    expect(views[0].bounds).toEqual({ x: 10, y: 21, width: 800, height: 601 });
    expect(manager.state("session-a").tabs[0].viewport).toEqual({ width: 800, height: 601, preset: null, mode: "fit" });
    expect(children.size).toBe(1);

    manager.destroy();
    expect(children.size).toBe(0);
    expect(views[0].webContents.destroyed).toBe(true);
  });

  test("a renderer reload HIDES the visible scope and keeps its page alive — never a release", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    await manager.setVisible("session-a", true);

    expect(() => manager.hideVisibleScope()).not.toThrow();
    expect(manager.visibleScopeKey).toBeNull();
    expect(views[0].visible).toBe(false);
    // The WebContents survives: an agent working in it mid-reload keeps its
    // page, and the returning panel shows it without a reload of its own.
    expect(children.size).toBe(1);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ url: "https://example.com/", active: true, sleeping: false }),
    ]);
  });

  test("an agent action in flight across a renderer reload finishes on the same page", async () => {
    let releaseWait;
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    const { manager, views } = makeHarness({ wait: async () => { enteredWait(); await gate; } });
    await manager.createTab("session-a", "https://a.example");
    await manager.setVisible("session-a", true);
    await manager.callTool("session-a", "browser_snapshot");
    const click = manager.callTool("session-a", "browser_click", { target: "e1", element: "Count 0 button" });
    await waiting;
    // The cockpit reloads mid-click (main.js did-start-loading → hideVisibleScope).
    manager.hideVisibleScope();
    releaseWait();
    const result = await click;
    expect(result.isError).toBeFalsy();
    expect(views[0].webContents.destroyed).toBe(false);
    expect(views[0].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed")).toBe(true);
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

    // An unseen page is refused before the ref is even looked up …
    const unseen = await manager.callTool("session-a", "browser_click", { target: "e404" });
    expect(unseen.isError).toBe(true);
    expect(textOf(unseen)).toContain("Take a fresh snapshot or screenshot");
    // … and a seen page with a ref the snapshot never minted is refused too.
    await manager.callTool("session-a", "browser_snapshot", {});
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

describe("the shared-browser interaction model — human input wins, agent defers then looks again", () => {
  function harness(options = {}) {
    const clock = { t: 1_000_000 };
    const changes = [];
    const base = makeHarness({
      ...options,
      now: () => clock.t,
      onControlChanged: (change) => changes.push(change),
      // The manager's own waits advance the fake clock, so a deferred action
      // can time out without real time passing.
      wait: async (ms) => {
        clock.t += ms;
      },
    });
    return { ...base, clock, changes };
  }
  async function observed(manager, scope = "s") {
    const result = await manager.callTool(scope, "browser_snapshot", {});
    expect(result.isError).toBeUndefined();
  }

  test("a fresh tab needs one look before its first mutation; reads never gate", async () => {
    const { manager, changes } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    const unseen = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(unseen.isError).toBe(true);
    // Console and network are logs, not a view: they do not bless the page.
    await manager.callTool("s", "browser_console_messages", {});
    expect((await manager.callTool("s", "browser_click", { target: "e1" })).isError).toBe(true);
    const snap = await manager.callTool("s", "browser_snapshot", {});
    expect(snap.isError).toBeUndefined();
    const clicked = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(clicked.isError).toBeUndefined();
    expect(changes[0]).toMatchObject({ controller: "agent" });
  });

  test("human input bumps the generation: the next mutation is refused as STALE until the agent looks again — nothing replays", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    clock.t += 10_000;
    expect(manager.noteHumanInput("s")).toBe(true);
    clock.t += 2_000; // hands lifted
    const before = views[0].webContents.debugger.commands.length;
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you last looked");
    expect(textOf(stale)).toContain("the human interacted");
    // No input was dispatched for the refused click.
    expect(views[0].webContents.debugger.commands.slice(before).filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(0);
    await observed(manager);
    const fresh = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(fresh.isError).toBeUndefined();
  });

  test("while the human is actively interacting the mutation DEFERS, then proceeds once they stop", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    await observed(manager); // the agent looked after the human's input
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(result.isError).toBeUndefined();
    // It waited until HUMAN_ACTIVE_MS had elapsed, no longer.
    expect(clock.t - t0).toBeGreaterThanOrEqual(1_500);
    expect(clock.t - t0).toBeLessThan(2_000);
  });

  test("continuous human input is never an indefinite lock: the deferral is bounded and answers with a reason", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    await observed(manager);
    // The human keeps touching the tab on every poll.
    const original = manager.wait;
    manager.wait = async (ms) => {
      await original(ms);
      manager.noteHumanInput("s", { force: true });
    };
    manager.noteHumanInput("s", { force: true });
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is interacting with tab 0");
    expect(clock.t - t0).toBeLessThanOrEqual(5_200);
  });

  test("a navigation is a new page: a mutation decided from the old one is refused — even after the agent's OWN navigate, it looks first", async () => {
    const { manager, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    // The page navigated on its own (a redirect, a link the human followed).
    views[0].webContents.emit("did-navigate");
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("the page navigated");
    // The agent navigates deliberately: allowed without a fresh view (it
    // leaves the page rather than acting on it) — but the landing page is
    // unseen, so the next click still waits for a look.
    const nav = await manager.callTool("s", "browser_navigate", { url: "https://example.org" });
    expect(nav.isError).toBeUndefined();
    const unseen = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(unseen.isError).toBe(true);
    expect(textOf(unseen)).toContain("the page navigated");
    await observed(manager);
    const ok = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(ok.isError).toBeUndefined();
  });

  test("human input DURING an in-flight action is detected between steps, not swallowed by the busy grace", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    // Slow typing: the first character goes out, then a human types too.
    const debug = views[0].webContents.debugger;
    let inserted = 0;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.insertText") {
        inserted += 1;
        // A real hand, well outside the synthetic window, while the call is busy.
        if (inserted === 2) {
          clock.t += 500;
          expect(manager.noteHumanInput("s")).toBe(true);
        }
      }
      return result;
    };
    const result = await manager.callTool("s", "browser_type", { target: "e1", text: "hello", slowly: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Stopped");
    expect(inserted).toBeLessThan(5);
  });

  test("the agent's own click raises ONE preload report, which is consumed — a SECOND report during the same call is a human", async () => {
    const { manager, views, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    const attributed = [];
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        // The page echoes our pointerdown — late, as a hidden view does (~1.1 s measured).
        clock.t += 1_200;
        attributed.push(manager.noteHumanInput("s"));
        // …and then a real hand lands while the same call is still busy.
        attributed.push(manager.noteHumanInput("s"));
      }
      return result;
    };
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(attributed).toEqual([false, true]);
    // The click had already been dispatched; the result says the human cut in.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Clicked");
    expect(textOf(result)).toContain("is interacting with tab 0");
  });

  test("an expected report that never arrives expires: it cannot swallow a human's click seconds later", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.callTool("s", "browser_click", { target: "e1" }); // expected one report; none came
    clock.t += 2_500;
    expect(manager.noteHumanInput("s")).toBe(true);
  });

  test("force:true (the cockpit's chrome) during an in-flight action marks the interruption too", async () => {
    const { manager, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    let inserted = 0;
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.insertText" && ++inserted === 2) manager.noteHumanInput("s", { force: true });
      return result;
    };
    const result = await manager.callTool("s", "browser_type", { target: "e1", text: "hello", slowly: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Stopped");
    expect(inserted).toBeLessThan(5);
  });

  test("typing in the address bar signals intent BEFORE submit: the next mutation defers", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.action("s", { action: "intent" });
    expect(manager.state("s").tabs[0].controller).toBe("human");
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    // Stale (the human's intent bumped the generation) — and only after deferring.
    expect(result.isError).toBe(true);
    expect(clock.t - t0).toBeGreaterThanOrEqual(1_500);
  });

  test("a TIMED-OUT action cannot keep mutating once its successor starts: its next step stops on the cancelled context", async () => {
    const { manager, views, clock } = harness({ rpcTimeoutMs: 50 });
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const inserts = [];
    debug.sendCommand = async (method, params) => {
      if (method === "Input.insertText") {
        inserts.push(params.text);
        if (inserts.length === 1) await gate; // the first char hangs past the timeout
      }
      return originalSend(method, params);
    };
    const slow = manager.callTool("s", "browser_type", { target: "e1", text: "abc", slowly: true });
    await new Promise((resolve) => setTimeout(resolve, 80)); // real time: the 50ms RPC timeout fires
    const timedOut = await slow;
    expect(textOf(timedOut)).toContain("timed out");
    // A successor starts on the same tab while the old operation still hangs.
    await observed(manager);
    const next = manager.callTool("s", "browser_type", { target: "e1", text: "Z" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release(); // the old continuation resumes now — its next checkpoint must stop it
    await next;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The old action inserted its first char before hanging, then STOPPED —
    // "b" and "c" never went out; the successor's "Z" did.
    expect(inserts).toEqual(["a", "Z"]);
  });

  test("a queued close acts on the tab it was queued for, by identity, not on whatever index means later", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    // Human active on tab 1 (current): closing it defers.
    manager.noteHumanInput("s", { force: true });
    const pending = manager.callTool("s", "browser_tabs", { action: "close", index: 1 });
    // Meanwhile the human closes tab 0, so "index 1" would now be out of range.
    manager.closeTab("s", 0, "human");
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const urls = manager.state("s").tabs.map((tab) => tab.url);
    expect(urls).not.toContain("https://two.example/");
  });

  test("a pinned mutation whose tab is closed while it waits fails — it is never redirected to the active tab", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    await observed(manager);
    manager.noteHumanInput("s", { force: true });
    await observed(manager);
    const pending = manager.callTool("s", "browser_click", { target: "e1" });
    manager.closeTab("s", 0, "human");
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/closed/);
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  test("a mutation is pinned to the tab it was queued for: a tab switch during its wait cannot redirect it", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await observed(manager);
    manager.noteHumanInput("s", { force: true });
    await observed(manager);
    // Deferred (human active on tab 0). While it waits, tab 1 opens and becomes current.
    const pending = manager.callTool("s", "browser_click", { target: "e1" });
    await manager.performAction("s", { action: "new", url: "https://two.example" }, "human");
    expect(manager.state("s").tabs[1].active).toBe(true);
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const clicks = (view) => view.webContents.debugger.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;
    expect(clicks(views[0])).toBeGreaterThan(0);
    expect(clicks(views[1])).toBe(0);
  });

  test("conflicting mutations on ONE tab run in order; another tab's mutation does not wait", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    await observed(manager);
    manager.noteHumanInput("s", { force: true }); // human active on tab 0
    await observed(manager);
    const order = [];
    const first = manager.callTool("s", "browser_click", { target: "e1" }).then(() => order.push("tab0-first"));
    const second = manager.callTool("s", "browser_click", { target: "e1" }).then(() => order.push("tab0-second"));
    // Tab 1: independent. Observe it, then its mutation lands WITHOUT waiting
    // for tab 0's deferral (the fake clock only advances through waits).
    await manager.callTool("s", "browser_snapshot", { tabId: 1 });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 1 });
    const t0 = clock.t;
    const tab1 = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(tab1.isError).toBeUndefined();
    expect(clock.t - t0).toBeLessThan(1_500);
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);
    clock.t += 5_000;
    await Promise.all([first, second]);
    expect(order).toEqual(["tab0-first", "tab0-second"]);
  });

  test("the cockpit's URL bar is human by construction and needs no attribution window", async () => {
    const { manager } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.action("s", { action: "navigate", url: "https://example.org" });
    expect(manager.state("s").tabs[0].controller).toBe("human");
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
  });

  test("state and list carry an ADVISORY activity that decays on its own — nothing to hand back", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    expect(manager.state("s").tabs[0].controller).toBe("human");
    expect(textOf(await manager.callTool("s", "browser_tabs", { action: "list" }))).toMatch(/\{controller=human, opened-by=agent\}/);
    clock.t += 2_000;
    expect(manager.state("s").tabs[0].controller).toBe("idle");
    expect(typeof manager.handBack).toBe("undefined");
  });

  test("human input reported from a tab's own webContents marks THAT tab only", async () => {
    const { manager, views, clock } = harness();
    await manager.createTab("s", "localhost:3000");
    await manager.createTab("s", "https://example.com");
    clock.t += 10_000;
    manager.noteHumanInputFromWebContents(views[0].webContents);
    expect(manager.state("s").tabs[0].controller).toBe("human");
    expect(manager.state("s").tabs[1].controller).toBe("idle");
    manager.noteHumanInputFromWebContents({ unknown: true });
  });

  test("the tab cap refuses the 13th tab with a sentence; closing the last tab leaves one blank", async () => {
    const { manager } = harness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("s", "about:blank");
    const overCap = await manager.callTool("s", "browser_tabs", { action: "new" });
    expect(overCap.isError).toBe(true);
    expect(textOf(overCap)).toContain("Tab limit reached");

    const solo = harness();
    await solo.manager.createTab("t", "https://example.com");
    solo.manager.closeTab("t", 0, "human");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tabs = solo.manager.state("t").tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe("about:blank");
  });

  test("destroying a scope journals idle for its tabs", async () => {
    const { manager, changes } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    manager.releaseScope("s", true);
    expect(changes.at(-1).controller).toBe("idle");
  });
});

describe("the credential boundary — private interaction gates every browser tool in every scope", () => {
  test("while private, reads and mutations in ANY scope are refused with the reason; logs are not captured", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s1", "https://one.example");
    await manager.createTab("s2", "https://two.example");
    await manager.callTool("s2", "browser_snapshot", {});
    manager.privacy.begin("1Password", "s1");
    for (const [scope, name, args] of [["s1", "browser_snapshot", {}], ["s2", "browser_snapshot", {}], ["s2", "browser_click", { target: "e1" }], ["s2", "browser_take_screenshot", {}], ["s2", "browser_console_messages", {}], ["s2", "browser_tabs", { action: "list" }]]) {
      const result = await manager.callTool(scope, name, args);
      expect(result.isError).toBe(true);
      // Actionable + retriable, not a terminal unexplained failure.
      expect(result.retriable).toBe(true);
      expect(textOf(result)).toMatch(/signing in|resume automatically/i);
    }
    // A console line emitted during privacy is dropped, not stored.
    const debug = views[1].webContents.debugger;
    await manager.ensureDebugger(manager.activeTab("s2"));
    debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "secret-ish" }] });
    expect(manager.activeTab("s2").console).toEqual([]);
    expect(manager.state("s2").privacy).toMatchObject({ private: true, reason: "1Password" });
  });

  test("a read in flight when privacy begins is discarded on return, and resume makes every page stale", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    await manager.callTool("s", "browser_snapshot", {});
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const debug = views[0].webContents.debugger;
    const original = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Accessibility.getFullAXTree") await gate; // every tree read waits on ONE gate
      return original(method, params);
    };
    const pending = manager.callTool("s", "browser_snapshot", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.privacy.begin("1Password", "s");
    release();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.discarded).toBe(true);
    await manager.resumeFromPrivate();
    expect(manager.state("s").privacy.private).toBe(false);
    // The agent's earlier snapshot no longer blesses the page.
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("a private interaction ended");
    await manager.callTool("s", "browser_snapshot", {});
    expect((await manager.callTool("s", "browser_click", { target: "e1" })).isError).toBeUndefined();
  });

  test("a credential field in use begins privacy on its own — inline fill included — and Resume is refused while a password field is still filled", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    await manager.callTool("s", "browser_snapshot", {});
    // The page's preload reports a fill landing in a password field.
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    expect(manager.state("s").privacy).toMatchObject({ private: true, reason: "credentials filled" });
    expect((await manager.callTool("s", "browser_snapshot", {})).isError).toBe(true);
    // The page still holds a filled password field: resume is refused.
    views[0].webContents.probeAnswers = [true];
    const refused = await manager.resumeFromPrivate();
    expect(refused.private).toBe(true);
    expect(refused.refused).toContain("credential field is still in use");
    // The human submits/clears; now resume goes through and the page is stale.
    views[0].webContents.probeAnswers = [false];
    const ended = await manager.resumeFromPrivate();
    expect(ended.private).toBe(false);
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("a private interaction ended");
  });

  test("Resume asks EVERY frame of EVERY tab and fails closed: a filled iframe, a missing probe, or a throwing frame all refuse — even on a tab that never reported a field", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("a", "https://one.example");
    await manager.createTab("b", "https://two.example");
    manager.privacy.begin("1Password", "a");
    // Tab b never reported a credential field; its login iframe is filled.
    views[1].webContents.probeAnswers = [false, true];
    expect((await manager.resumeFromPrivate()).refused).toContain("credential field is still in use");
    // A frame whose probe is missing cannot vouch for itself.
    views[1].webContents.probeAnswers = [false, null];
    expect((await manager.resumeFromPrivate()).refused).toBeDefined();
    // A frame that throws (torn down mid-question) is no better.
    views[1].webContents.probeAnswers = [new Error("frame gone")];
    expect((await manager.resumeFromPrivate()).refused).toBeDefined();
    // A tab with no frames at all cannot answer either.
    views[1].webContents.probeAnswers = [];
    expect((await manager.resumeFromPrivate()).refused).toBeDefined();
    views[1].webContents.probeAnswers = [false, false];
    expect((await manager.resumeFromPrivate()).private).toBe(false);
  });

  test("a frame whose safety probe NEVER resolves refuses the resume with an actionable message — it does not hang", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    manager.privacy.begin("1Password", "s");
    // A background frame wedged so its executeJavaScript never settles.
    views[0].webContents.probeAnswers = [false, "__hang__"];
    const started = Date.now();
    const result = await manager.resumeFromPrivate();
    // Resolved (bounded), refused, and told the human what to do.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.private).toBe(true);
    expect(result.refused).toContain("not responding to the safety check");
    expect(result.refused).toContain("Reload or close it");
    // The page settles (frame responds clean); resume now goes through.
    views[0].webContents.probeAnswers = [false, false];
    expect((await manager.resumeFromPrivate()).private).toBe(false);
  });

  test("a clean page after sign-in (no filled fields) resumes and makes every page stale", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    await manager.callTool("s", "browser_snapshot", {});
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    expect(manager.state("s").privacy.private).toBe(true);
    // Signed in: the form submitted, the password field is gone/empty.
    views[0].webContents.probeAnswers = [false];
    const ended = await manager.resumeFromPrivate();
    expect(ended.private).toBe(false);
    expect(ended.refused).toBeUndefined();
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("a private interaction ended");
  });

  test("privacy beginning drops every tab's captured console and network log, in every scope", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s1", "https://one.example");
    await manager.createTab("s2", "https://two.example");
    for (const [i, scope] of [[0, "s1"], [1, "s2"]]) {
      await manager.ensureDebugger(manager.activeTab(scope));
      views[i].webContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "before" }] });
      views[i].webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: "https://login.example/?token=abc" } });
    }
    expect(manager.activeTab("s1").console).toHaveLength(1);
    expect(manager.activeTab("s2").network).toHaveLength(1);
    manager.privacy.begin("1Password", "s1");
    for (const scope of ["s1", "s2"]) {
      expect(manager.activeTab(scope).console).toEqual([]);
      expect(manager.activeTab(scope).network).toEqual([]);
    }
  });

  test("a read or navigation whose tab lands on an extension page DURING the call is refused, not returned", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    const wc = views[0].webContents;
    // The page redirects to an extension page while the snapshot runs.
    const debug = wc.debugger;
    const original = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Accessibility.getFullAXTree") { wc.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/unlock.html"; }
      return original(method, params);
    };
    const snap = await manager.callTool("s", "browser_snapshot", {});
    expect(snap.isError).toBe(true);
    expect(textOf(snap)).toContain("now showing an extension page");
    // A navigate whose load redirects onto an extension page is refused too.
    wc.url = "https://example.com/";
    debug.sendCommand = original;
    await manager.callTool("s", "browser_snapshot", {});
    const realLoad = wc.loadURL.bind(wc);
    wc.loadURL = async (url) => { await realLoad(url); wc.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/redirected.html"; };
    const nav = await manager.callTool("s", "browser_navigate", { url: "https://sso.example/start" });
    expect(nav.isError).toBe(true);
    expect(textOf(nav)).toContain("now showing an extension page");
  });

  test("a QUEUED or IN-FLIGHT mutation stops at its next step when privacy begins under it", async () => {
    const clock = { t: 1_000_000 };
    const { manager, views } = makeHarness({ now: () => clock.t, wait: async (ms) => { clock.t += ms; } });
    await manager.createTab("s", "https://example.com");
    await manager.callTool("s", "browser_snapshot", {});
    const debug = views[0].webContents.debugger;
    const original = debug.sendCommand.bind(debug);
    let inserted = 0;
    debug.sendCommand = async (method, params) => {
      const result = await original(method, params);
      if (method === "Input.insertText" && ++inserted === 2) manager.privacy.begin("credential entry", "s");
      return result;
    };
    const typing = await manager.callTool("s", "browser_type", { target: "e1", text: "hello", slowly: true });
    expect(typing.isError).toBe(true);
    // Either the mid-action checkpoint ("Stopped:") or the on-return discard —
    // both carry the sign-in reason; the point is it did not run to completion.
    expect(textOf(typing)).toMatch(/sign-in|Stopped/);
    expect(inserted).toBeLessThan(5);
    // Queued behind a human deferral, privacy begins before it runs: refused before any input.
    await manager.resumeFromPrivate();
    await manager.callTool("s", "browser_snapshot", {});
    manager.noteHumanInput("s", { force: true });
    const before = debug.commands.length;
    const queued = manager.callTool("s", "browser_click", { target: "e1" });
    manager.privacy.begin("1Password", "s");
    clock.t += 5_000;
    const result = await queued;
    expect(result.isError).toBe(true);
    expect(debug.commands.slice(before).filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  test("an extension page is never a target: not read, not acted on, not navigated to, and named but not exposed in the list", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    views[0].webContents.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html";
    views[0].webContents.emit("did-navigate");
    for (const [name, args] of [["browser_snapshot", {}], ["browser_take_screenshot", {}], ["browser_click", { target: "e1" }], ["browser_console_messages", {}]]) {
      const result = await manager.callTool("s", name, args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("extension page");
    }
    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(textOf(listed)).toContain("[Extension page](about:blank)");
    expect(textOf(listed)).not.toContain("chrome-extension://");
    const nav = await manager.callTool("s", "browser_navigate", { url: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/options.html" });
    expect(nav.isError).toBe(true);
    const opened = await manager.callTool("s", "browser_tabs", { action: "new", url: "chrome://extensions" });
    expect(opened.isError).toBe(true);
  });
});

describe("hidden screenshots", () => {
  test("a fullPage capture that never settles still restores the tab's viewport", async () => {
    const { manager, views } = makeHarness();
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://one.example/" });
    const view = views[0];
    const wc = view.webContents;
    const tab = manager.activeTab("s");
    // The hidden path: never mounted, so capturePage is what runs — and here it hangs.
    wc.capturePage = () => new Promise(() => {});
    const debug = wc.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("scrollHeight")) return { result: { value: { width: 1280, height: 4000 } } };
      return originalSend(method, params);
    };
    // A short deadline for the test: the constant is module-private, so the
    // proof is that the restore happened, timed by the fake clock of awaits.
    const started = Date.now();
    const result = await Promise.race([
      manager.callTool("s", "browser_take_screenshot", { fullPage: true }),
      new Promise((resolve) => setTimeout(() => resolve({ isError: true, content: [{ type: "text", text: "test deadline" }] }), 9_000)),
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(9_000);
    const overrides = debug.commands.filter((entry) => entry.method === "Emulation.setDeviceMetricsOverride").map((entry) => `${entry.params.width}x${entry.params.height}`);
    // Enlarged for the capture, then put back to the unmounted viewport.
    expect(overrides).toEqual(["1280x800", "1280x4000", "1280x800"]);
    expect(tab.viewportOverride).toBe("1280x800@1");
  }, 15_000);
});

describe("the automatic credential lifecycle", () => {
  // Real (tiny) timers so the poll loop actually yields between iterations
  // instead of busy-spinning; the loop cadence is compressed to ~1ms.
  function lifecycleHarness() {
    return makeHarness({ lifecycle: true, wait: async () => new Promise((r) => setTimeout(r, 1)) });
  }
  // Let a few poll cycles run and observe the result.
  const settle = async () => { await new Promise((r) => setTimeout(r, 40)); };
  // Wait until a predicate holds (bounded) — for transitions gated on a real
  // probe timeout (~750ms), not just a poll tick.
  const until = async (fn, ms = 2_500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
    return fn();
  };

  test("a credential fill holds privacy until a clean probe, then auto-releases (no manual Resume)", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    views[0].webContents.probeAnswers = [true]; // filled
    expect(manager.state("s").privacy.private).toBe(true);
    await settle();
    expect(manager.state("s").privacy.private).toBe(true); // still filled → held
    // The person submits: fields clear. The loop auto-releases with no Resume.
    views[0].webContents.probeAnswers = [false];
    await settle();
    expect(manager.state("s").privacy.private).toBe(false);
    // The agent's next mutation is stale until it re-observes.
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("a private interaction ended");
  });

  test("a focused-but-empty password field keeps privacy (active entry), then releases when blurred/cleared", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "focus" });
    views[0].webContents.probeAnswers = [true]; // entry-active probe: focused OR filled
    await settle();
    expect(manager.state("s").privacy.private).toBe(true);
    views[0].webContents.probeAnswers = [false];
    await settle();
    expect(manager.state("s").privacy.private).toBe(false);
  });

  test("opening and closing 1Password never pauses browser tools, even if page probes cannot answer", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    views[0].webContents.probeAnswers = [new Promise(() => {})];
    manager.addUiHold("p:popup", "1Password");
    manager.addUiHold("w:extwin", "1Password");
    expect(manager.state("s").privacy.private).toBe(false);
    expect((await manager.callTool("s", "browser_tabs", { action: "list" })).isError).not.toBe(true);
    manager.removeUiHold("p:popup");
    manager.removeUiHold("w:extwin");
    await settle();
    expect(manager.state("s").privacy.private).toBe(false);
  });

  test("a fill landing WHILE a popup is open keeps privacy after the popup closes", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    manager.addUiHold("p:popup", "1Password");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    views[0].webContents.probeAnswers = [true]; // inline fill left a filled field
    manager.removeUiHold("p:popup");
    await settle();
    expect(manager.state("s").privacy.private).toBe(true); // fill still holds
    views[0].webContents.probeAnswers = [false];
    await settle();
    expect(manager.state("s").privacy.private).toBe(false);
  });

  test("a probe that never answers keeps privacy and marks it stuck — it never auto-releases on timeout", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    views[0].webContents.probeAnswers = [false, "__hang__"];
    // The wedged frame's probe must time out (~750ms) before "stuck" is set.
    expect(await until(() => manager.state("s").privacy.stuck === true)).toBe(true);
    expect(manager.state("s").privacy.private).toBe(true);
    // The agent gets the specific stuck recovery, not a promise of auto-clear.
    const busy = await manager.callTool("s", "browser_snapshot", {});
    expect(busy.isError).toBe(true);
    expect(textOf(busy)).toContain("not responding");
    // Recovery: the page clears; privacy releases and stuck lifts.
    views[0].webContents.probeAnswers = [false];
    expect(await until(() => manager.state("s").privacy.private === false)).toBe(true);
    expect(manager.state("s").privacy.stuck).toBe(false);
  });

  test("destroy stops the loop", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "fill" });
    views[0].webContents.probeAnswers = [true];
    await settle();
    manager.destroy();
    expect(manager._autoReleaseRunning === false || manager._disposed === true).toBe(true);
    await settle();
    expect(manager._disposed).toBe(true);
  });
});

describe("per-project browser profiles", () => {
  test("an UNBOUND scope refuses to open a tab — missing project metadata fails closed", async () => {
    const { manager } = makeHarness();
    // Bypass the harness auto-bind to exercise the real guard.
    manager.createTab = DesktopBrowserManager.prototype.createTab.bind(manager);
    await expect(manager.createTab("unbound", "https://example.com")).rejects.toThrow(/not bound to a project profile/);
  });
  test("two sessions of one project share a partition; a different project never does", () => {
    const { manager } = makeHarness();
    manager.declareProfile("a1", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("a2", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b1", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("a1")).toBe(manager.partitionOf("a2"));
    expect(manager.partitionOf("b1")).not.toBe(manager.partitionOf("a1"));
    expect(manager.state("a1").profileKey).toBe("project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
  test("the legacy partition is used only by its declared owner", () => {
    const { manager } = makeHarness();
    manager.profileMapping = { legacyOwnerProjectId: "project_cccccccccccccccccccccccccccccccc" };
    manager.declareProfile("owner", "project_cccccccccccccccccccccccccccccccc");
    manager.declareProfile("other", "project_dddddddddddddddddddddddddddddddd");
    expect(manager.partitionOf("owner")).toBe("persist:telar-integrated-browser");
    expect(manager.partitionOf("other")).not.toBe("persist:telar-integrated-browser");
  });
  test("a tab keeps its partition; the extension host is resolved per partition", async () => {
    const { manager } = makeHarness();
    const hostsByPartition = new Map();
    manager.createExtensionHost = (partition) => {
      const host = { partition, added: [], addTab(wc) { this.added.push(wc); }, removeTab() {}, selectTab() {}, whenReady: async () => ({}) };
      hostsByPartition.set(partition, host);
      return host;
    };
    manager.declareProfile("a", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await manager.createTab("a", "https://one.example");
    await manager.createTab("b", "https://two.example");
    const pa = manager.partitionOf("a");
    const pb = manager.partitionOf("b");
    expect(pa).not.toBe(pb);
    expect(hostsByPartition.get(pa).added).toHaveLength(1);
    expect(hostsByPartition.get(pb).added).toHaveLength(1);
    // A's tab never reached B's host.
    expect(hostsByPartition.get(pa).added[0]).not.toBe(hostsByPartition.get(pb).added[0]);
  });
  test("adopt refuses tabs from a different profile", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("from", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("to", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await manager.createTab("from", "https://one.example");
    expect(() => manager.adoptScope("from", "to")).toThrow(/across browser profiles/);
  });
});

describe("the persisted tab inventory — the manager owns tab lifetime across reload and restart", () => {
  const PROJECT = "project_0123456789abcdef0123456789abcdef";
  function memoryStore(initial = null) {
    const writes = [];
    return {
      writes,
      load: () => initial,
      save: (doc) => writes.push(doc),
      flushSync: (doc) => writes.push({ ...doc, sync: true }),
      latest: () => writes.at(-1),
    };
  }
  function harnessWith(tabStore, options = {}) {
    const views = [];
    let nextId = 1;
    const window = { isDestroyed: () => false, webContents: { send: () => {} }, contentView: { addChildView: () => {}, removeChildView: () => {} } };
    const manager = new DesktopBrowserManager(window, {
      createId: () => `tab-${nextId++}`,
      createView: () => { const view = new FakeView(); views.push(view); return view; },
      wait: async () => {},
      tabStore,
      ...options,
    });
    manager.ensureAutoRelease = () => {};
    return { manager, views };
  }

  test("every emitted change is remembered: order, active tab, opener, viewport — and closing a tab drops it (no resurrection)", async () => {
    const store = memoryStore();
    const { manager } = harnessWith(store);
    manager.declareProfile("s1", PROJECT);
    await manager.createTab("s1", "https://one.example/", "human");
    await manager.createTab("s1", "https://two.example/");
    await manager.resizeTab(manager.activeTab("s1"), { preset: "phone" });
    await manager.selectTab("s1", 0);
    let doc = store.latest();
    expect(doc.scopes.s1.profileKey).toBe(PROJECT);
    expect(doc.scopes.s1.activeTabId).toBe("tab-1");
    expect(doc.scopes.s1.tabs.map((tab) => [tab.id, tab.url, tab.openedBy, tab.viewport])).toEqual([
      ["tab-1", "https://one.example/", "human", undefined],
      ["tab-2", "https://two.example/", "agent", { width: 390, height: 844 }],
    ]);
    manager.closeTab("s1", 1, "human");
    doc = store.latest();
    expect(doc.scopes.s1.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  });

  test("a restart restores the inventory LAZILY: records with no WebContents, in their profile's partition, loaded on first use only", async () => {
    const remembered = {
      version: 1,
      savedAt: 1,
      scopes: {
        s1: {
          profileKey: PROJECT,
          activeTabId: "b",
          tabs: [
            { id: "a", url: "https://one.example/", title: "One", openedBy: "human" },
            { id: "b", url: "https://two.example/", title: "Two", openedBy: "agent", viewport: { width: 768, height: 1024 } },
          ],
        },
        s2: { profileKey: "none", activeTabId: "c", tabs: [{ id: "c", url: "https://three.example/", title: "Three", openedBy: "agent" }] },
      },
    };
    const { manager, views } = harnessWith(memoryStore(remembered));
    // Nothing navigated at startup.
    expect(views).toHaveLength(0);
    expect(manager.profileOf("s1")).toBe(PROJECT);
    expect(manager.profileOf("s2")).toBe("none");
    const state = manager.state("s1");
    expect(state.tabs.map((tab) => [tab.id, tab.url, tab.title, tab.active, tab.sleeping, tab.openedBy])).toEqual([
      ["a", "https://one.example/", "One", false, true, "human"],
      ["b", "https://two.example/", "Two", true, true, "agent"],
    ]);
    expect(state.tabs[1].viewport).toEqual({ width: 768, height: 1024, preset: "tablet", mode: "fixed" });
    // The partition comes from the profile, never from the file.
    expect(manager.scopeTabs("s1").every((tab) => tab.partition === `persist:telar-project-${PROJECT.slice("project_".length)}`)).toBe(true);
    expect(manager.scopeTabs("s2")[0].partition).toBe("persist:telar-profile-none");
    // First use wakes exactly the tab asked for.
    const listed = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    expect(listed).toContain("https://two.example/");
    expect(views).toHaveLength(1);
    expect(views[0].webContents.getURL()).toBe("https://two.example/");
    expect(manager.state("s1").tabs.map((tab) => tab.sleeping)).toEqual([true, false]);
    // A remembered tab's intrinsic viewport is what its new WebContents is told.
    const override = views[0].webContents.debugger.commands.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(override.params).toMatchObject({ width: 768, height: 1024 });
  });

  test("a remembered scope is never re-bound to a different profile — the fail-closed rule holds after a restart too", () => {
    const { manager } = harnessWith(memoryStore({
      version: 1, savedAt: 1,
      scopes: { s1: { profileKey: PROJECT, activeTabId: "a", tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "agent" }] } },
    }));
    expect(() => manager.declareProfile("s1", "none")).toThrow(/already has tabs in profile/);
    expect(manager.declareProfile("s1", PROJECT).partition).toBe(`persist:telar-project-${PROJECT.slice("project_".length)}`);
  });

  test("a legacy-owner mapping change at restart drops the scope rather than landing it in another project's jar", () => {
    // Persisted while `legacy` mapped to project A; restored under a mapping
    // that no longer names an owner: `legacy` is unmappable → the scope is
    // forgotten, not assigned.
    const { manager } = harnessWith(memoryStore({
      version: 1, savedAt: 1,
      scopes: { s1: { profileKey: "legacy", activeTabId: "a", tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "agent" }] } },
    }), { profileMapping: { legacyOwnerProjectId: null } });
    expect(manager.scopeTabs("s1")).toEqual([]);
    expect(manager.profileOf("s1")).toBeNull();
  });

  test("destroy writes the inventory synchronously before the views go, with each live view's current URL", async () => {
    const store = memoryStore();
    const { manager, views } = harnessWith(store);
    manager.declareProfile("s1", "none");
    await manager.createTab("s1", "https://one.example/");
    // The page redirected under the record; destroy remembers where it IS.
    views[0].webContents.url = "https://one.example/after-redirect";
    manager.destroy();
    const last = store.latest();
    expect(last.sync).toBe(true);
    expect(last.scopes.s1.tabs[0].url).toBe("https://one.example/after-redirect");
    // Nothing is written after disposal.
    const count = store.writes.length;
    manager.persist();
    expect(store.writes.length).toBe(count);
  });
});

describe("per-tab viewports — intrinsic size independent of the column, presentation-only fit", () => {
  const { fitViewport, resolveViewport } = require("./browser-manager");

  test("fitViewport scales down to fit and centres, never scales up", () => {
    expect(fitViewport({ width: 1280, height: 800 }, { x: 10, y: 20, width: 640, height: 400 })).toEqual({ scale: 0.5, rect: { x: 10, y: 20, width: 640, height: 400 } });
    expect(fitViewport({ width: 1280, height: 800 }, { x: 0, y: 0, width: 640, height: 600 })).toEqual({ scale: 0.5, rect: { x: 0, y: 100, width: 640, height: 400 } });
    expect(fitViewport({ width: 390, height: 844 }, { x: 0, y: 0, width: 1000, height: 900 })).toEqual({ scale: 1, rect: { x: 305, y: 28, width: 390, height: 844 } });
  });

  test("resolveViewport accepts presets and clamps custom sizes", () => {
    expect(resolveViewport({ preset: "tablet" })).toEqual({ width: 768, height: 1024 });
    expect(resolveViewport({ width: 50, height: 99999 })).toEqual({ width: 200, height: 5000 });
    expect(resolveViewport({ width: 5000, height: 5000 })).toEqual({ width: 5000, height: 3000 });
    expect(() => resolveViewport({ preset: "watch" })).toThrow(/Unknown viewport preset/);
    expect(() => resolveViewport({})).toThrow(/numeric width and height/);
  });

  test("a FIXED tab in a narrow panel keeps the page at 1280×800 and scales the presentation; hidden tabs are emulated at scale 1", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    await manager.callTool("s", "browser_snapshot", {});
    // A never-shown fit tab has no meaningful size yet: the stable fallback.
    const hidden = debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    expect(hidden.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    // Explicit opt-in to a fixed size.
    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    // Same intrinsic viewport; only the presentation scale changes.
    expect(shown.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 0.5 });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
    expect(manager.state("s").presentation).toMatchObject({ width: 1280, height: 800, scale: 0.5, rect: { width: 640, height: 400 } });
    // A CDP click from a snapshot's CSS point is dispatched at the NATIVE
    // (scaled) point — measured in Electron: the unscaled point misses.
    await manager.callTool("s", "browser_snapshot", {});
    await manager.callTool("s", "browser_click", { target: "e1" });
    const pressed = debug.commands.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
    // The fake element centre is (120, 80) in CSS px (FakeDebugger's rect).
    expect(pressed.params).toMatchObject({ x: 60, y: 40 });
    // A screenshot is the INTRINSIC page: an explicit 1280×800 clip at scale 1.
    await manager.callTool("s", "browser_take_screenshot", {});
    const shot = debug.commands.find((c) => c.method === "Page.captureScreenshot");
    expect(shot.params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true });
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
      // Untouched: fit, never shown, reporting the stable fallback.
      { width: 1280, height: 800, preset: "default", mode: "fit" },
      { width: 390, height: 844, preset: "phone", mode: "fixed" },
    ]);
    const debug = views[1].webContents.debugger;
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 390, height: 844 });
    // The snapshot taken before the resize describes a page that no longer exists.
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("resized");
    // The toolbar path: a custom size on the addressed tab.
    const state = await manager.action("s", { action: "resize", index: 0, width: 1000, height: 700 });
    expect(state.tabs[0].viewport).toEqual({ width: 1000, height: 700, preset: null, mode: "fixed" });
    expect(state.tabs[1].viewport).toEqual({ width: 390, height: 844, preset: "phone", mode: "fixed" });
  });
});

describe("the geometry pipeline — bounds and emulation are serialized per tab, latest wins", () => {
  test("a preset change places the view for the NEW size and re-asserts it after the emulation settles — no stale bounds from an older run", async () => {
    // The bleed: an Emulation command in flight while a resize landed, then
    // an older bounds computation re-applied. Gate the debugger so the two
    // overlap deterministically.
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
    // Start a resize (its emulation stalls), then a panel bounds change lands.
    const resize = manager.resizeTab(tab, { preset: "phone" });
    manager.setBounds("s", { x: 0, y: 0, width: 400, height: 400 });
    release();
    await resize;
    await tab.geometry.queue;
    // Final bounds are for phone (390×844) fitted into 400×400: scale 0.4739 → 185×400, centred x=107.
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
    // 1000×700 into 640×400: scale = min(0.64, 0.571) → 571×400, centred x=34.
    expect(view.bounds).toEqual({ x: 34, y: 0, width: 571, height: 400 });
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 1000, height: 700 });
  });

  test("a republish of UNCHANGED bounds still re-places the view (the renderer's self-heal path)", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const view = views[0];
    view.bounds = { x: 9, y: 9, width: 9, height: 9 }; // drifted somehow
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.activeTab("s").geometry.queue;
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
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
    // VISIBLE FIT IS NATIVE: the emulation is CLEARED, never set to the stage
    // (an emulated stage lagging the bounds by a frame read as zoom).
    expect(debug.commands.at(-1).method).toBe("Emulation.clearDeviceMetricsOverride");
    expect(tab.viewportOverride).toBe("native");
    // The panel grows: the viewport follows (no rescale), and the change is stale-marking.
    await manager.callTool("s", "browser_snapshot", {});
    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 900, height: 500 });
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 500 });
    // Still no emulation while shown, however many times the panel moves.
    manager.setBounds("s", { x: 0, y: 0, width: 880, height: 480 });
    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("resized");
    // Hidden: keeps 900×500 for the background agent, at scale 1.
    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 900, height: 500 });
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
    // Shown again in a narrower panel: follows again.
    manager.setBounds("s", { x: 0, y: 0, width: 500, height: 300 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(manager.viewportOf(tab)).toEqual({ width: 500, height: 300 });
    // Back to fixed keeps the current size; a later panel change no longer follows.
    await manager.resizeTab(tab, { mode: "fixed" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    expect(manager.state("s").tabs[0].viewport).toEqual({ width: 500, height: 300, preset: null, mode: "fixed" });
    // Panel bounds below the minimum (a closing animation) are NOT adopted: the last meaningful size is kept.
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
    const restored = new DesktopBrowserManager(window, { createId: () => "x", createView: () => new FakeView(), wait: async () => {}, tabStore: { load: () => doc, save: () => {}, flushSync: () => {} } });
    restored.ensureAutoRelease = () => {};
    expect(restored.state("s").tabs[0].viewport).toEqual({ width: 640, height: 400, preset: null, mode: "fit" });
  });
});

describe("navigation replacement — ERR_ABORTED from a superseded load is not a failure", () => {
  function replacing(views, finalUrl) {
    // The FakeWebContents' loadURL rejects like Electron does when the page
    // replaces its own load, while a second navigation starts and lands.
    const wc = views[0].webContents;
    wc.loadURL = async function (url) {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      // The page's own location.replace: a second main-frame navigation.
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`);
      error.errno = -3;
      error.code = "ERR_ABORTED";
      queueMicrotask(() => {
        this.url = finalUrl;
        this.title = "Landed";
        this.emit("did-navigate");
        this.emit("did-stop-loading");
      });
      throw error;
    };
    return wc;
  }

  test("a page that replaces its own load answers with the replacement's outcome, human and agent paths alike", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    replacing(views, "https://landed.example/");
    const state = await manager.action("s", { action: "navigate", url: "https://bounce.example/?themeRefresh=1" });
    expect(state.tabs[0].url).toBe("https://landed.example/");
    const result = await manager.callTool("s", "browser_navigate", { url: "https://bounce.example/?themeRefresh=1" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("landed.example");
  });

  test("an abort with NO replacement, and any other failure, still throws", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = views[0].webContents;
    wc.loadURL = async function () {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-stop-loading");
      const error = new Error("ERR_ABORTED (-3)");
      error.errno = -3;
      throw error;
    };
    wc.isLoading = () => false;
    await expect(manager.action("s", { action: "navigate", url: "https://stopped.example/" })).rejects.toThrow(/ERR_ABORTED/);
    wc.loadURL = async function () {
      const error = new Error("ERR_CONNECTION_REFUSED (-102)");
      error.errno = -102;
      throw error;
    };
    await expect(manager.action("s", { action: "navigate", url: "https://dead.example/" })).rejects.toThrow(/CONNECTION_REFUSED/);
  });

  test("a replacement that itself fails reports THAT failure", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = views[0].webContents;
    wc.loadURL = async function (url) {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`);
      error.errno = -3;
      queueMicrotask(() => this.emit("did-fail-load", null, -105, "ERR_NAME_NOT_RESOLVED", "https://nowhere.example/", true));
      throw error;
    };
    wc.isLoading = () => true;
    await expect(manager.action("s", { action: "navigate", url: "https://bounce.example/" })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe("the start page's contract — onVisited and the hidden blank view", () => {
  test("onVisited fires for a committed http(s) top-level navigation only: not blank, not an error status, not an extension page, not while private", async () => {
    const visited = [];
    const { manager, views } = makeHarness({ onVisited: (scopeKey, url) => visited.push([scopeKey, url]) });
    await manager.createTab("s", "https://one.example/");
    const wc = views[0].webContents;
    wc.url = "https://two.example/path"; wc.emit("did-navigate", null, "https://two.example/path", 200);
    wc.url = "https://err.example/"; wc.emit("did-navigate", null, "https://err.example/", 404);
    wc.url = "chrome-extension://abc/x.html"; wc.emit("did-navigate", null, "chrome-extension://abc/x.html", 200);
    wc.url = "about:blank"; wc.emit("did-navigate", null, "about:blank", 0);
    manager.privacy.begin("popup", "s");
    wc.url = "https://login.example/"; wc.emit("did-navigate", null, "https://login.example/", 200);
    expect(visited).toEqual([["s", "https://one.example/"], ["s", "https://two.example/path"]]);
  });

  test("a blank active tab shows NO native view (the DOM start page is under it); a navigation reveals it", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank", "human");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const tab = manager.activeTab("s");
    await tab.geometry.queue;
    expect(views[0].visible).toBe(false);
    await manager.action("s", { action: "navigate", url: "https://one.example/" });
    await tab.geometry.queue;
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });
});

describe("navigation replacement — the waiter's endings", () => {
  function stalledReplacement(views) {
    const wc = views[0].webContents;
    wc.isLoading = () => true;
    wc.loadURL = async function () {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      throw Object.assign(new Error("ERR_ABORTED (-3)"), { errno: -3 });
    };
    return wc;
  }
  const EVENTS = ["did-start-navigation", "did-navigate", "did-navigate-in-page", "did-fail-load", "did-stop-loading", "destroyed"];

  test("a replacement whose load STOPS before any commit is a failure, not a success", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const pending = manager.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc.emit("did-stop-loading");
    await expect(pending).rejects.toThrow(/stopped before a page committed/);
  });

  test("a tab closed mid-replacement rejects; a same-document replacement counts as a commit", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const closed = manager.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc.emit("destroyed");
    await expect(closed).rejects.toThrow(/closed while the page/);
    const { manager: m2, views: v2 } = makeHarness();
    await m2.createTab("s", "about:blank");
    const wc2 = stalledReplacement(v2);
    const inPage = m2.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc2.url = "https://bounce.example/#landed";
    wc2.emit("did-navigate-in-page");
    await expect(inPage).resolves.toBeTruthy();
  });

  test("the deadline rejects AND removes every listener it attached", async () => {
    const { manager, views } = makeHarness({ rpcTimeoutMs: 30 });
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const before = EVENTS.map((name) => wc.listenerCount(name));
    await expect(manager.action("s", { action: "navigate", url: "https://bounce.example/" })).rejects.toThrow(/never settled/);
    expect(EVENTS.map((name) => wc.listenerCount(name))).toEqual(before);
  });
});

describe("bounds are per scope — a stale scope's publish never moves the visible view", () => {
  test("a late setBounds for the session the renderer left does not re-place the shown session's view; it applies when that session is shown again", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("A", "https://a.example/");
    await manager.createTab("B", "https://b.example/");
    // A is shown at 640×400, then the route switches to B at 900×500.
    manager.setBounds("A", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("A", true);
    await manager.setVisible("A", false);
    manager.setBounds("B", { x: 10, y: 20, width: 900, height: 500 });
    await manager.setVisible("B", true);
    await manager.activeTab("B").geometry.queue;
    expect(views[1].bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });
    // A's in-flight publish (a rAF/IPC that was already dispatched) lands late.
    manager.setBounds("A", { x: 0, y: 0, width: 300, height: 200 });
    await manager.activeTab("B").geometry.queue;
    expect(manager.bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });
    expect(views[1].bounds).toEqual({ x: 10, y: 20, width: 900, height: 500 });
    expect(views[1].visible).toBe(true);
    expect(views[0].visible).toBe(false);
    // Back to A: it shows at its OWN last rect, not B's.
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
    await manager.setVisible("A", false); // the old panel's unmount cleanup
    await manager.activeTab("B").geometry.queue;
    expect(manager.visibleScopeKey).toBe("B");
    expect(views[1].visible).toBe(true);
  });
});
