const { EventEmitter } = require("node:events");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager, managerForScope, normalizeUrl, looksLikeAddress } = require("./browser-manager");

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
    this.devToolsOpen = false;
    this.devToolsOptions = null;
    this.inspected = [];
    this.edits = [];
    this.downloads = [];
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
    this.windowOpenHandler = null;
    // The credential probe, per frame: tests set `probeAnswers` to one
    // answer per frame (false = empty, true = filled, null = probe missing,
    // an Error = the frame threw).
    this.probeAnswers = [false];
    const self = this;
    this.mainFrame = {
      get framesInSubtree() {
        return self.probeAnswers.map((answer) => ({
          executeJavaScript: (source) => {
            if (String(source).includes("active.blur()")) {
              if (answer && typeof answer === "object" && answer.emptyFocused) {
                answer.blurred = true;
                answer.probe = false;
                return Promise.resolve(true);
              }
              return Promise.resolve(false);
            }
            if (answer === "__hang__") return new Promise(() => {}); // never settles
            if (answer instanceof Error) return Promise.reject(answer);
            if (answer && typeof answer === "object" && "probe" in answer) return Promise.resolve(answer.probe);
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

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  openWindow(url) {
    if (!this.windowOpenHandler) return { action: "allow" };
    return this.windowOpenHandler({ url });
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

  // DevTools, as much of them as the manager touches (#423). `inspected` is
  // the point "Inspect" aimed them at.
  isDevToolsOpened() {
    return this.devToolsOpen;
  }

  openDevTools(options) {
    this.devToolsOpen = true;
    this.devToolsOptions = options;
    this.emit("devtools-opened");
  }

  closeDevTools() {
    if (!this.devToolsOpen) return;
    this.devToolsOpen = false;
    this.emit("devtools-closed");
  }

  inspectElement(x, y) {
    this.inspected.push({ x, y });
  }

  // The edit and media verbs the context menu dispatches, recorded rather
  // than performed.
  cut() { this.edits.push("cut"); }
  copy() { this.edits.push("copy"); }
  paste() { this.edits.push("paste"); }
  selectAll() { this.edits.push("select-all"); }
  replaceMisspelling(word) { this.edits.push(`replace:${word}`); }
  copyImageAt(x, y) { this.edits.push(`copy-image:${x},${y}`); }
  downloadURL(url) { this.downloads.push(url); }

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
  // The one Electron seam the page context menu needs (#423): the native Menu
  // it pops, and the clipboard "Copy Link" writes to. Every built menu is kept
  // so a test can read the rows and click one by label.
  const menus = [];
  const clipboard = { text: "", writeText(value) { this.text = value; } };
  const electron = () => ({
    clipboard,
    Menu: {
      buildFromTemplate: (template) => {
        const menu = { template, popups: 0, popup: () => { menu.popups += 1; } };
        menus.push(menu);
        return menu;
      },
    },
  });
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
    electron,
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
    ...(options.onCredentialEntryFinished ? { onCredentialEntryFinished: options.onCredentialEntryFinished } : {}),
    ...(options.tabStore ? { tabStore: options.tabStore } : {}),
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
  return { children, clipboard, manager, menus, messages, views, waits };
}

/** Fire a real right-click on a tab's page and return the rows Chromium's menu
 *  would have shown. */
function rightClick(harness, view, params = {}) {
  view.webContents.emit("context-menu", {}, { x: 12, y: 34, pageURL: view.webContents.getURL(), ...params });
  return harness.menus.at(-1);
}

/** Pick a row by its label — what a person does with the mouse. */
function pick(menu, label) {
  const item = menu.template.find((entry) => entry.label === label);
  if (!item) throw new Error(`No context-menu row labelled ${JSON.stringify(label)}; saw ${menu.template.map((entry) => entry.label ?? "—").join(", ")}`);
  item.click();
  return item;
}

function textOf(result) {
  return (result.content || []).map((part) => part.text || "").join("\n");
}

describe("normalizeUrl", () => {
  test("normalizes local addresses without accepting non-web protocols", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("https://example.com/path")).toBe("https://example.com/path");
    // file: renders in the sandboxed tab now (local guides, compiled PDFs).
    // The dangerous half — handing file: to shell.openExternal — stays
    // refused by createExternalLinkPolicy, tested in external-links.test.js.
    expect(normalizeUrl("file:///tmp/example.html")).toBe("file:///tmp/example.html");
    // A bare absolute path is the file, the way every address bar reads it —
    // including one with a space, which pathToFileURL escapes.
    expect(normalizeUrl("/tmp/my guide.html")).toBe("file:///tmp/my%20guide.html");
    // Every other scheme stays out: openExternal-adjacent handlers included.
    expect(() => normalizeUrl("smb://server/share")).toThrow("only opens http, https and file URLs");
    expect(() => normalizeUrl("javascript://alert(1)")).toThrow("only opens http, https and file URLs");
  });
});

describe("the address bar tells an address from words to search for", () => {
  test("an address is a path, a scheme, or a host with no whitespace", () => {
    // Hosts: a dot, `localhost`, or an IP — each with an optional port.
    expect(looksLikeAddress("github.com")).toBe(true);
    expect(looksLikeAddress("localhost:3000")).toBe(true);
    expect(looksLikeAddress("localhost")).toBe(true);
    expect(looksLikeAddress("127.0.0.1")).toBe(true);
    expect(looksLikeAddress("[::1]:8080")).toBe(true);
    // An explicit scheme is taken at its word, dotless host and all.
    expect(looksLikeAddress("https://x")).toBe(true);
    expect(looksLikeAddress("file:///tmp/a")).toBe(true);
    // An absolute path is the file, and keeps being one even with a space.
    expect(looksLikeAddress("/tmp/my guide.html")).toBe(true);
  });
  test("words are words — the cases that used to surface 'Invalid URL'", () => {
    expect(looksLikeAddress("hello world")).toBe(false);
    expect(looksLikeAddress("telar")).toBe(false);
    expect(looksLikeAddress("what is 2+2")).toBe(false);
    expect(looksLikeAddress("")).toBe(false);
  });
  test("normalizeUrl searches for what is not an address, and encodes it", () => {
    expect(normalizeUrl("hello world")).toBe("https://www.google.com/search?q=hello%20world");
    expect(normalizeUrl("telar")).toBe("https://www.google.com/search?q=telar");
    // The + of "2+2" survives as a plus rather than becoming a space.
    expect(normalizeUrl("what is 2+2")).toBe("https://www.google.com/search?q=what%20is%202%2B2");
    // And the addresses above still resolve as addresses.
    expect(normalizeUrl("github.com")).toBe("http://github.com/");
    expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1/");
    expect(normalizeUrl("https://x")).toBe("https://x/");
    // A blank tab is neither.
    expect(normalizeUrl("about:blank")).toBe("about:blank");
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

  test("opens target-blank web links as managed browser tabs", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://one.example/", "human");

    expect(views[0].webContents.openWindow("https://popup.example/path")).toEqual({ action: "deny" });
    await manager.settlePopupTabs();

    const state = manager.state("session-a");
    expect(state.tabs.map((tab) => [tab.url, tab.active, tab.agentFocus, tab.openedBy])).toEqual([
      ["https://one.example/", false, false, "human"],
      ["https://popup.example/path", true, true, "human"],
    ]);
  });

  test("keeps agent-triggered popups off the human's current browser tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://human.example/", "human");
    await manager.createTab("session-a", "https://agent.example/", "agent");
    const agentTab = manager.scopeTabs("session-a")[1];
    agentTab.agentBusy = 1;

    expect(views[1].webContents.openWindow("https://popup.example/oauth")).toEqual({ action: "deny" });
    await manager.settlePopupTabs();
    agentTab.agentBusy = 0;

    const state = manager.state("session-a");
    expect(state.tabs.map((tab) => [tab.url, tab.active, tab.agentFocus, tab.openedBy])).toEqual([
      ["https://human.example/", true, false, "human"],
      ["https://agent.example/", false, false, "agent"],
      ["https://popup.example/oauth", false, true, "agent"],
    ]);
  });

  test("refuses protected and non-web popup targets without creating a browser tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://one.example/", "human");

    for (const target of ["chrome-extension://abc/popup.html", "chrome://extensions", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(views[0].webContents.openWindow(target)).toEqual({ action: "deny" });
    }
    await manager.settlePopupTabs();

    expect(manager.state("session-a").tabs).toHaveLength(1);
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

  // The panel's menus (the "+" chooser, the profile and viewport popovers) are
  // real portals again, and this is the whole mechanism behind that: the native
  // view is composited ABOVE the renderer's DOM, so a menu can only be seen
  // while the view is down. Hiding it for a menu must therefore be as cheap and
  // as reversible as hiding it for the start page — same page, same rect.
  test("hiding for an open menu and showing on close keeps the page and its rect", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://a.example");
    manager.setBounds("session-a", { x: 40, y: 80, width: 900, height: 600 });
    await manager.setVisible("session-a", true);
    const placed = views[0].bounds;
    expect(placed).toBeTruthy();

    // A menu opens over the panel.
    await manager.setVisible("session-a", false);
    expect(views[0].visible).toBe(false);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(children.size).toBe(1);

    // …and closes. The renderer republishes nothing: the scope's own remembered
    // rect comes back with it, so the page does not jump.
    await manager.setVisible("session-a", true);
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual(placed);
    expect(views[0].webContents.getURL()).toBe("https://a.example/");
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
    // `yours` rides in the same braces: the one tab is both what the human is
    // looking at and where the agent's calls land.
    // The braces also carry the tab's own id and the profile it is signed into
    // (the credential path binds to the identity of the page it types into, and
    // `tabId` is a position that renumbers), so this asserts the facts rather
    // than the exact suffix.
    const listed = textOf(await manager.callTool("s", "browser_tabs", { action: "list" }));
    expect(listed).toMatch(/controller=human, opened-by=agent/);
    expect(listed).toMatch(/\byours\}/);
    expect(listed).toMatch(/\{tab=[^,}]+,/);
    expect(listed).toMatch(/profile=bp_[a-f0-9]{16}/);
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

  test("the tab cap refuses the 13th tab with a sentence", async () => {
    const { manager } = harness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("s", "about:blank");
    const overCap = await manager.callTool("s", "browser_tabs", { action: "new" });
    expect(overCap.isError).toBe(true);
    expect(textOf(overCap)).toContain("Tab limit reached");
  });

  /**
   * CLOSING THE LAST TAB ENDS THE BROWSER — issue #383.
   *
   * It used to mint one blank tab instead, so "I am done with this browser"
   * was a sentence the panel could not hear: every attempt to say it came back
   * as a fresh New Tab. Every gesture that can empty the strip is here, because
   * they are three different call sites (the × and the menu's Close reach
   * `action`; Close others loops) and only one of them was ever exercised.
   */
  describe("the last tab closing ends the browser", () => {
    test("no blank tab is minted, the view is torn down, and the push says ended", async () => {
      const { manager, children, views, messages } = harness();
      await manager.createTab("t", "https://example.com", "human");
      const view = views[0];
      messages.length = 0;

      manager.closeTab("t", 0, "human");
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(manager.state("t").tabs).toEqual([]);
      // The native WebContentsView is off the window and its WebContents is
      // closed — not merely hidden behind a panel that stopped drawing it.
      expect(children.has(view)).toBe(false);
      expect(view.webContents.isDestroyed()).toBe(true);

      const pushes = messages.filter((message) => message.channel === "telar:browser:state");
      expect(pushes.at(-1).payload).toMatchObject({ scopeKey: "t", ended: true, tabs: [] });
    });

    test("`ended` is an EVENT, so a later read of the state does not repeat it", async () => {
      // Otherwise a panel opened on this scope again would close itself the
      // moment it asked what was there.
      const { manager } = harness();
      await manager.createTab("t", "https://example.com", "human");
      manager.closeTab("t", 0, "human");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("t").ended).toBeUndefined();
    });

    test("opening a browser again starts fresh — the profile binding outlives the browser", async () => {
      // `forgetScope` would drop it, and an unbound scope is REFUSED a tab. What
      // ends is the browser, not the session's right to have one.
      const { manager } = harness();
      await manager.createTab("t", "https://example.com", "human");
      manager.closeTab("t", 0, "human");
      await new Promise((resolve) => setTimeout(resolve, 5));

      await manager.createTab("t", "https://again.example", "human");
      const tabs = manager.state("t").tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ url: "https://again.example/", active: true });
    });

    test("the tab strip's × and the tab menu's Close both end it", async () => {
      for (const index of [undefined, 0]) {
        const { manager } = harness();
        await manager.createTab("t", "https://example.com", "human");
        // `action` is the IPC the cockpit's own chrome speaks: the × sends an
        // index, the menu's Close sends the one it was opened on.
        await manager.action("t", { action: "close", ...(index === undefined ? {} : { index }) });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(manager.state("t").tabs).toEqual([]);
      }
    });

    test("Close others then Close leaves nothing — the strip empties and stays empty", async () => {
      const { manager } = harness();
      await manager.createTab("t", "https://one.example", "human");
      await manager.createTab("t", "https://two.example", "human");
      // Close others walks DOWN, as the renderer's menu does.
      await manager.action("t", { action: "close", index: 0 });
      expect(manager.state("t").tabs).toHaveLength(1);
      await manager.action("t", { action: "close", index: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("t").tabs).toEqual([]);
    });

    test("an AGENT closing its last tab ends it too, and is told its tab is gone", async () => {
      // One rule rather than two: a divided one ("the human's close ends it,
      // the agent's does not") is the kind a later reader cannot hold true.
      const { manager } = harness();
      await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
      await manager.callTool("s", "browser_tabs", { action: "close" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("s").tabs).toEqual([]);
      const orphaned = await manager.callTool("s", "browser_snapshot", {});
      expect(orphaned.isError).toBe(true);
      expect(textOf(orphaned)).toContain("was closed");
      // …and navigating opens a fresh one rather than refusing forever.
      expect((await manager.callTool("s", "browser_navigate", { url: "https://again.example" })).isError).toBeUndefined();
      expect(manager.state("s").tabs).toHaveLength(1);
    });
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
  // 15 s, the bound the engine suite's `eventually`/`until` helpers carry,
  // under the 20 s bunfig ceiling: every caller asserts the predicate came
  // true, so a healthy run leaves on the first passing poll and only a loaded
  // runner ever spends the budget (#458).
  const until = async (fn, ms = 15_000) => {
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

  test("closing extension chrome blurs empty credential focus so privacy can auto-release", async () => {
    const { manager, views } = lifecycleHarness();
    await manager.createTab("s", "https://example.com");
    const password = { probe: true, emptyFocused: true, blurred: false };
    views[0].webContents.probeAnswers = [password];
    manager.addUiHold("p:popup", "1Password");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "focus" });
    expect(manager.state("s").privacy.private).toBe(true);
    manager.removeUiHold("p:popup");
    expect(await until(() => manager.state("s").privacy.private === false)).toBe(true);
    expect(password.blurred).toBe(true);
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
  test("two sessions of one project share a partition; a project assigned elsewhere does not", () => {
    const { manager } = makeHarness();
    manager.declareProfile("a1", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("a2", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b1", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("a1")).toBe(manager.partitionOf("a2"));
    /**
     * TWO PROJECTS WITH NO ASSIGNMENT NOW SHARE THE DEFAULT, and that is the
     * point of the default: one identity, signed into once. Separation is
     * something a person asks for by assigning a profile — not something four
     * unnamed auto-minted jars impose on them.
     */
    expect(manager.partitionOf("b1")).toBe(manager.partitionOf("a1"));
    const own = manager.profiles.create({ label: "B's own" });
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", own.id);
    manager.declareProfile("b2", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("b2")).not.toBe(manager.partitionOf("a1"));
    expect(manager.state("a1").profileKey).toBe("project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
  test("the legacy partition is used only by its declared owner", () => {
    const { manager } = makeHarness();
    manager.profiles.document.legacyOwnerProjectId = "project_cccccccccccccccccccccccccccccccc";
    // The legacy jar exists on disk; the ladder adopts it for its owner only.
    manager.profiles.partitionExists = (partition) => partition === "persist:telar-integrated-browser";
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
    // Two DIFFERENT identities, which since the single default means saying so:
    // an unassigned project joins the default rather than minting its own jar.
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", manager.profiles.create({ label: "B" }).id);
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
  test("switching a session's profile leaves its open tabs in the identity they were signed into", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await manager.createTab("s", "https://one.example");
    const before = manager.scopeTabs("s")[0];
    const beforePartition = before.partition;
    const view = before.view;

    const other = manager.profiles.create({ label: "Other" });
    const binding = manager.setScopeProfile("s", other.id);
    expect(binding.profileId).toBe(other.id);
    // The live tab did not move: same WebContents, same partition, same jar.
    expect(before.view).toBe(view);
    expect(before.partition).toBe(beforePartition);
    expect(before.profileId).not.toBe(other.id);

    await manager.createTab("s", "https://two.example");
    const [old, fresh] = manager.scopeTabs("s");
    expect(old.partition).toBe(beforePartition);
    expect(fresh.partition).toBe(other.partition);
    // And the panel can tell them apart.
    const state = manager.state("s");
    expect(state.profile.id).toBe(other.id);
    expect(state.tabs.map((tab) => tab.profileId)).toEqual([old.profileId, other.id]);
  });

  test("a session's own profile choice survives the engine re-declaring the same project every turn", () => {
    const { manager } = makeHarness();
    const project = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    manager.declareProfile("s", project);
    const chosen = manager.profiles.create({ label: "Chosen" });
    manager.setScopeProfile("s", chosen.id);
    expect(manager.declareProfile("s", project).profileId).toBe(chosen.id);
    expect(manager.partitionOf("s")).toBe(chosen.partition);
  });

  test("a project assigned to a profile puts every one of its sessions in that identity", () => {
    const { manager } = makeHarness();
    const shared = manager.profiles.create({ label: "Shared" });
    manager.profiles.assign("project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shared.id);
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shared.id);
    manager.declareProfile("a", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("a")).toBe(shared.partition);
    expect(manager.partitionOf("b")).toBe(shared.partition);
    // Unassigned, a project with no jar of its own falls to the DEFAULT — and
    // with a different default it lands somewhere else entirely.
    const personal = manager.profiles.create({ label: "Personal" });
    manager.profiles.setDefault(personal.id);
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null);
    expect(manager.declareProfile("b2", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").partition).toBe(personal.partition);
    // The project that IS assigned did not move with the default.
    expect(manager.declareProfile("a2", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").partition).toBe(shared.partition);
  });

  test("a scope that would switch PROJECT with tabs open is refused, and a dangling profile id is never guessed", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await manager.createTab("s", "https://one.example");
    expect(() => manager.declareProfile("s", "none")).toThrow(/already has tabs in profile/);
    expect(() => manager.setScopeProfile("s", "bp_00000000000000ff")).toThrow(/No browser profile/);
  });

  /**
   * WHAT DELETE MAY REFUSE ON (#430). The Delete button in Settings did
   * nothing on any machine that had been used: the shell refused whenever any
   * scope NAMED the profile, and every open session names one from the moment
   * it opens. The rule is a fact about tabs, and it lives here now because the
   * manager is what holds them.
   */
  describe("whyProfileIsInUse — the live half of the delete rule", () => {
    test("a session bound to the profile with nothing open does not block it", () => {
      const { manager } = makeHarness();
      const profile = manager.profiles.create({ label: "Spare" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", profile.id);
      // The binding is real — this is exactly the state that used to refuse.
      expect(manager.scopeProfiles.get("s")).toBe(profile.id);
      expect(manager.whyProfileIsInUse(profile.id)).toBeNull();
      // And nothing at all points at a profile no session ever chose.
      expect(manager.whyProfileIsInUse(manager.profiles.create({ label: "Untouched" }).id)).toBeNull();
    });

    test("a session with tabs open in it is refused, with a sentence naming the profile and the way out", async () => {
      const { manager } = makeHarness();
      const profile = manager.profiles.create({ label: "Work" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", profile.id);
      await manager.createTab("s", "https://one.example");
      expect(manager.whyProfileIsInUse(profile.id)).toBe(
        "A session has a tab open in “Work”. Close it, or switch that session to another profile, first.",
      );
      await manager.createTab("s", "https://two.example");
      expect(manager.whyProfileIsInUse(profile.id)).toContain("2 tabs open in “Work”");
      // Closing them gives the way out the sentence promised.
      manager.closeTab("s", 1, "human");
      manager.closeTab("s", 0, "human");
      expect(manager.whyProfileIsInUse(profile.id)).toBeNull();
    });

    test("a tab left behind by a session that switched profiles still holds the profile it was signed into", async () => {
      const { manager } = makeHarness();
      const old = manager.profiles.create({ label: "Old" });
      const next = manager.profiles.create({ label: "Next" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", old.id);
      await manager.createTab("s", "https://one.example");
      // The switch moves the BINDING; the open page keeps its jar.
      manager.setScopeProfile("s", next.id);
      expect(manager.whyProfileIsInUse(old.id)).toContain("“Old”");
      // And the profile the session is now pointed at counts that same tab: a
      // restore drops a whole scope whose profile the registry has forgotten.
      expect(manager.whyProfileIsInUse(next.id)).toContain("“Next”");
    });

    test("a remembered session's hibernated tabs count — they are what a delete would throw away", () => {
      const { manager } = makeHarness({
        tabStore: {
          load: () => ({
            version: 1,
            savedAt: 1,
            scopes: {
              s1: {
                profileKey: "project_0123456789abcdef0123456789abcdef",
                activeTabId: "a",
                tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "human" }],
              },
            },
          }),
          save: () => {},
          flushSync: () => {},
        },
      });
      const restored = manager.profiles.get(manager.profiles.defaultProfileId);
      expect(manager.scopeTabs("s1")).toHaveLength(1);
      expect(manager.scopeTabs("s1")[0].view).toBeNull();
      expect(manager.whyProfileIsInUse(restored.id)).toContain("a tab open in");
    });

    test("nothing is refused for a blank or unknown profile id", () => {
      const { manager } = makeHarness();
      expect(manager.whyProfileIsInUse("")).toBeNull();
      expect(manager.whyProfileIsInUse(undefined)).toBeNull();
      expect(manager.whyProfileIsInUse("bp_00000000000000ff")).toBeNull();
    });
  });

  test("adopt refuses tabs from a different profile", async () => {
    const { manager } = makeHarness();
    // The two projects must be in different identities for there to be anything
    // to refuse; unassigned ones now share the default.
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", manager.profiles.create({ label: "To" }).id);
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
  /**
   * The manager coalesces its inventory WALK to one per turn of the event loop
   * (#296: `emitState` fires on every page event and the walk is over every tab
   * of every scope). So a synchronous mutation is on disk one microtask later;
   * anything the test already awaits has flushed it.
   */
  const settled = () => Promise.resolve();
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
    // The AGENT's tab, named explicitly: an agent-opened tab no longer takes
    // the human's view, so "the active tab" is no longer a way to say "the one
    // that was just opened".
    await manager.resizeTab(manager.scopeTabs("s1")[1], { preset: "phone" });
    await manager.selectTab("s1", 0);
    let doc = store.latest();
    expect(doc.scopes.s1.projectKey).toBe(PROJECT);
    expect(doc.scopes.s1.activeTabId).toBe("tab-1");
    expect(doc.scopes.s1.tabs.map((tab) => [tab.id, tab.url, tab.openedBy, tab.viewport])).toEqual([
      ["tab-1", "https://one.example/", "human", undefined],
      ["tab-2", "https://two.example/", "agent", { width: 390, height: 844 }],
    ]);
    manager.closeTab("s1", 1, "human");
    await settled();
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
    // The partition comes from the profile, never from the file: neither scope
    // picked one and neither has a jar of its own, so both are the default's.
    const fallback = manager.profiles.get(manager.profiles.defaultProfileId).partition;
    expect(manager.scopeTabs("s1").every((tab) => tab.partition === fallback)).toBe(true);
    expect(manager.scopeTabs("s2")[0].partition).toBe(fallback);
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
    expect(manager.declareProfile("s1", PROJECT).partition).toBe(manager.profiles.get(manager.profiles.defaultProfileId).partition);
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
    // The registry is a FILE in the app; a restart reads the same one, which is
    // what lets a remembered tab find the profile it names.
    const restored = new DesktopBrowserManager(window, { createId: () => "x", createView: () => new FakeView(), wait: async () => {}, profiles: manager.profiles, tabStore: { load: () => doc, save: () => {}, flushSync: () => {} } });
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

/**
 * THE COMPLAINT THIS ANSWERS: "agents can't use other tabs if I'm using a tab,
 * they automatically need to use the one I'm using."
 */
describe("two pointers — the human's view and the agent's tab move independently", () => {
  function harness(options = {}) {
    const clock = { t: 1_000_000 };
    const base = makeHarness({ ...options, now: () => clock.t, wait: async (ms) => { clock.t += ms; } });
    return { ...base, clock };
  }
  const observed = async (manager, args = {}) => {
    const result = await manager.callTool("s", "browser_snapshot", args);
    expect(result.isError).toBeUndefined();
  };

  test("a tab the agent opens does not take the screen, and the human's stays put", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://issues.example/", "human");
    await manager.setVisible("s", true);

    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://docs.example/" });
    const tabs = manager.state("s").tabs;
    // You are still reading the issue you opened...
    expect(tabs.map((tab) => [tab.url, tab.active, tab.agentFocus])).toEqual([
      ["https://issues.example/", true, false],
      ["https://docs.example/", false, true],
    ]);
    // ...and the agent's next un-addressed call lands in ITS tab, not yours.
    expect(manager.agentTab("s").url).toBe("https://docs.example/");
  });

  test("the human switching tabs does not re-aim the agent's next click", async () => {
    const { manager, views } = harness();
    await manager.createTab("s", "https://issues.example/", "human");
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://docs.example/" });
    await observed(manager);

    // The human moves to their own tab, the way clicking the strip does.
    await manager.selectTab("s", 0);
    expect(manager.state("s").tabs[0].active).toBe(true);

    const clicked = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(clicked.isError).toBeUndefined();
    const clicks = (view) => view.webContents.debugger.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;
    // The agent's tab took the click; the tab you are reading was not touched.
    expect(clicks(views[1])).toBeGreaterThan(0);
    expect(clicks(views[0])).toBe(0);
  });

  test("the agent selecting a tab moves only itself", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await manager.selectTab("s", 1);

    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    expect(manager.state("s").tabs[1].active).toBe(true); // still yours
    expect(manager.agentTab("s").url).toBe("https://one.example/"); // now theirs
  });

  test("a write may name a tab, and naming one does not weaken the human's claim on it", async () => {
    const { manager, views, clock } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await observed(manager, { tabId: 1 });

    // Addressed explicitly, and it lands.
    const direct = await manager.callTool("s", "browser_click", { target: "e1", tabId: 1 });
    expect(direct.isError).toBeUndefined();
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);

    // But a tab the human is USING still defers and then refuses — naming a
    // tab is addressing, never permission.
    await observed(manager, { tabId: 0 });
    manager.noteHumanInput("s", { force: true, tab: manager.scopeTabs("s")[0] });
    const contested = await manager.callTool("s", "browser_click", { target: "e1", tabId: 0 });
    clock.t += 10_000;
    expect(contested.isError).toBe(true);
    expect(textOf(contested)).toMatch(/interacting with tab 0|changed since you last looked/);
  });

  test("a closed agent tab is reported once, not silently swapped for the human's", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://yours.example/", "human");
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://mine.example/" });
    await observed(manager);

    // The human closes the tab the agent was working in.
    manager.closeTab("s", 1, "human");

    const orphaned = await manager.callTool("s", "browser_snapshot", {});
    expect(orphaned.isError).toBe(true);
    expect(textOf(orphaned)).toMatch(/was closed\. List the tabs/);
    // Said ONCE: the next call resolves normally rather than stranding the
    // agent, and listing tabs is how it recovers — so that must never fail.
    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(listed.isError).toBeUndefined();
    expect(manager.agentTab("s").url).toBe("https://yours.example/");
  });

  test("with no tab of its own the agent follows the human — 'look at this page' still works", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");

    await manager.selectTab("s", 1);
    expect(manager.agentTab("s").url).toBe("https://two.example/");
    await manager.selectTab("s", 0);
    expect(manager.agentTab("s").url).toBe("https://one.example/");
  });
});

describe("the agent's pointer follows the tabs through a scope's life", () => {
  test("adoption carries the agent's tab; destroying a scope leaves no tombstone for the next one", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("draft", "none");
    await manager.createTab("draft", "https://one.example/", "human");
    await manager.callTool("draft", "browser_tabs", { action: "new", url: "https://two.example/" });
    expect(manager.agentTab("draft").url).toBe("https://two.example/");

    manager.adoptScope("draft", "real");
    // The agent is still working in the same page, under the new scope.
    expect(manager.agentTab("real").url).toBe("https://two.example/");
    expect(manager.agentTabIds.has("draft")).toBe(false);

    // A destroyed scope's id must come back clean: its closed tabs are not an
    // error to report to whoever uses that id next.
    manager.releaseScope("real", true);
    expect(manager.agentTabIds.has("real")).toBe(false);
    expect(manager.agentTabClosed.has("real")).toBe(false);
  });
});

test("an extension host that re-selects a newly added tab cannot move the human's view", async () => {
  /**
   * THE SECOND DOOR, found by running the shipped nightly rather than the
   * tests: `createTab` correctly declines to move the human's pointer for an
   * agent tab, and then `readyHostForTab` hands the tab to the 1Password host,
   * whose library selects it — and the shell wires that to `selectTab`, the
   * human's pointer. The tab came back `(current)` and the screen moved.
   */
  const { manager } = makeHarness();
  manager.declareProfile("s", "none");
  const host = {
    added: [],
    // Exactly main.js's wiring: the host's selection drives the HUMAN's view.
    addTab(webContents) {
      this.added.push(webContents);
      const tab = manager.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
      if (tab) void manager.selectTab(tab.scopeKey, manager.scopeTabs(tab.scopeKey).indexOf(tab));
    },
    removeTab() {},
    selectTab() {},
    whenReady: async () => ({}),
  };
  manager.createExtensionHost = () => host;

  await manager.createTab("s", "https://yours.example/", "human");
  await manager.callTool("s", "browser_tabs", { action: "new", url: "https://mine.example/" });

  const tabs = manager.state("s").tabs;
  expect(host.added).toHaveLength(2); // the host really was told about both
  expect(tabs.map((tab) => [tab.url, tab.active, tab.agentFocus])).toEqual([
    ["https://yours.example/", true, false],
    ["https://mine.example/", false, true],
  ]);
});

test("only an interruption is reported as the human taking the browser", async () => {
  const clock = { t: 1_000_000 };
  const changes = [];
  const { manager } = makeHarness({ now: () => clock.t, onControlChanged: (change) => changes.push(change), wait: async (ms) => { clock.t += ms; } });
  await manager.createTab("s", "https://example.com/", "human");

  // Touching a tab with no agent action in flight: a control change, but not
  // an interruption — nothing for the transcript to explain.
  clock.t += 10_000;
  manager.noteHumanInput("s", { force: true });
  expect(changes.at(-1)).toMatchObject({ controller: "human" });
  expect(changes.at(-1).interrupted).toBeUndefined();

  // Cutting into an agent action IS worth saying.
  const tab = manager.scopeTabs("s")[0];
  tab.agentBusy = 1;
  tab.lastJournaled = "agent";
  clock.t += 10_000;
  manager.noteHumanInput("s", { force: true });
  expect(changes.at(-1)).toMatchObject({ controller: "human", interrupted: true });
});

// ── the login offer capture (AUTH-001, #195) ───────────────────────────────
//
// The manager's half of login-offer.js: WHEN a capture is taken (a value in a
// credential field, never mere focus), WHAT it holds (the tab's top-level
// address and identity at that moment — metadata only), and WHEN it is handed
// on (the automatic release that ends the private window). The offer's own
// decisions are covered in login-offer.test.js and login-offer-flow.test.js.
describe("the login offer capture", () => {
  test("an entry captures the tab's address and identity; focus captures nothing", async () => {
    const finished = [];
    const clock = { t: 50_000 };
    const { manager, views } = makeHarness({ now: () => clock.t, onCredentialEntryFinished: (capture) => finished.push(capture) });
    await manager.createTab("s", "https://accounts.example.com/signin?next=/inbox");
    const wc = views[0].webContents;

    manager.noteCredentialFieldFromWebContents(wc, { kind: "focus" });
    expect(manager.heldLoginCapture).toBeNull();

    manager.noteCredentialFieldFromWebContents(wc, { kind: "fill" });
    expect(manager.heldLoginCapture).toMatchObject({
      origin: "https://accounts.example.com",
      tabUid: manager.scopeTabs("s")[0].id,
      at: 50_000,
    });
    expect(manager.heldLoginCapture.profileId).toBeTruthy();
  });

  test("the capture is taken AT ENTRY and a later navigation does not move it", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "input" });
    // The sign-in redirects; the held capture still names the typed-into page.
    await views[0].webContents.loadURL("https://mail.example.com/u/0");
    expect(manager.heldLoginCapture.origin).toBe("https://accounts.example.com");
  });

  test("the automatic release hands the capture on, once", async () => {
    const finished = [];
    const { manager, views } = makeHarness({ onCredentialEntryFinished: (capture) => finished.push(capture) });
    await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "input" });
    manager.autoRelease();
    expect(finished.length).toBe(1);
    expect(finished[0].origin).toBe("https://accounts.example.com");
    expect(manager.heldLoginCapture).toBeNull();
    // A release with nothing held (the next one) hands nothing on.
    manager.autoRelease();
    expect(finished.length).toBe(1);
  });

  test("a page that cannot carry a grant is never captured", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    manager.noteCredentialFieldFromWebContents(views[0].webContents, { kind: "input" });
    expect(manager.heldLoginCapture).toBeNull();
  });

  test("loginCaptureForScope — the explicit offer's capture — reads the active tab now", async () => {
    const clock = { t: 90_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://mail.example.com/u/0", "human");
    const capture = manager.loginCaptureForScope("s");
    expect(capture).toMatchObject({ origin: "https://mail.example.com", at: 90_000 });
    // A page with no http(s) origin answers null, not a broken offer.
    const { manager: blank } = makeHarness();
    await blank.createTab("s2", "about:blank", "human");
    expect(blank.loginCaptureForScope("s2")).toBeNull();
  });
});

/**
 * ISSUE #296. The main process climbed to 100% CPU and multi-gigabyte memory
 * over five hours and died with a V8 SIGTRAP, and nothing in the app could
 * say which structure had grown. These are the counts the heap log reads
 * (main.js startHeapLog) and the bounds that keep them from being the answer.
 */
describe("what the main process holds — the heap log's counts (#296)", () => {
  test("diagnostics counts the live views, their listeners and every growing collection", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.createTab("s", "https://two.example/");

    const before = manager.diagnostics();
    expect(before).toMatchObject({ scopes: 1, tabs: 2, liveViews: 2, extensionHosts: 0 });
    // bindTab's registrations are real and counted; the exact number is the
    // manager's business, but it must be non-zero and must not climb on its own.
    expect(before.wcListeners).toBeGreaterThan(0);

    views[0].webContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }] });
    views[0].webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: "https://one.example/api" } });
    expect(manager.diagnostics()).toMatchObject({ consoleEntries: 1, networkEntries: 1 });

    // A HIBERNATED TAB IS NOT A LIVE VIEW, and its listeners go with it.
    manager.requestHibernate(manager.scopeTabs("s")[0]);
    const after = manager.diagnostics();
    expect(after.liveViews).toBe(1);
    expect(after.tabs).toBe(2);
    expect(after.wcListeners).toBeLessThan(before.wcListeners);
  });

  test("re-waking a tab does not leave a second set of listeners behind", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.scopeTabs("s")[0];
    const fresh = manager.diagnostics().wcListeners;

    // Five hibernate/wake cycles: the registrations belong to the WebContents,
    // so a tab recreated five times must read exactly as one tab does.
    for (let i = 0; i < 5; i += 1) {
      manager.requestHibernate(tab);
      await manager.wakeTab(tab);
    }
    expect(manager.diagnostics()).toMatchObject({ liveViews: 1, wcListeners: fresh });
  });
});

/**
 * ISSUE #296, THE BOUNDS. Every structure the audit found growing without a
 * matching removal, and the walk whose cost grew with it.
 */
describe("the main process holds a bounded amount (#296)", () => {
  test("a captured console line is bounded in BYTES, not only in count", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    const tab = manager.activeTab("s");

    // A console.log of something enormous — the CDP preview arrives whole.
    debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "x".repeat(5_000_000) }] });
    expect(tab.console).toHaveLength(1);
    expect(tab.console[0].text.length).toBeLessThan(2_100);
    // Truncation is stated, never silent: the reader is told it lost something
    // rather than being handed a plausible-looking half line.
    expect(tab.console[0].text).toContain("truncated");

    // Log.entryAdded takes the same path.
    debug.emit("message", {}, "Log.entryAdded", { entry: { level: "error", text: "y".repeat(4_000) } });
    expect(tab.console[1].text.length).toBeLessThan(2_100);

    // And a request URL, which for a data: request IS the payload.
    debug.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: `data:image/png;base64,${"A".repeat(3_000_000)}` } });
    expect(tab.network[0].url.length).toBeLessThan(2_100);
  });

  test("the capture keeps the newest 200 and drops the oldest, in place", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    const tab = manager.activeTab("s");
    const before = tab.console;

    for (let i = 0; i < 250; i += 1) {
      debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: `line ${i}` }] });
      debug.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: `https://one.example/${i}` } });
    }
    expect(tab.console).toHaveLength(200);
    expect(tab.network).toHaveLength(200);
    expect(tab.console[0].text).toBe("line 50");
    expect(tab.console.at(-1).text).toBe("line 249");
    // The same array throughout: the old slice(-200) allocated a fresh one on
    // every message, on the main thread, for every request of every page.
    expect(tab.console).toBe(before);
  });

  test("an agent expectation whose echo never arrives expires instead of accumulating", async () => {
    const clock = { t: 1_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");

    // Fifty clicks on a tab whose preload never reports back (a hidden view, a
    // page that reports nothing): each one used to leave its expectation for
    // the life of the tab, because only the consuming path ran the TTL filter.
    for (let i = 0; i < 50; i += 1) {
      clock.t += 100;
      manager.stampAgentInput(tab, 1);
    }
    // SYNTHETIC_REPORT_TTL_MS is 2 s, so only the last 2 s of clicks survive.
    expect(tab.expectedReports.length).toBeLessThanOrEqual(21);

    clock.t += 10_000;
    manager.stampAgentInput(tab, 1);
    expect(tab.expectedReports).toEqual([clock.t]);
  });

  test("an expectation still swallows the agent's own echo within its TTL", async () => {
    const clock = { t: 1_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");

    manager.stampAgentInput(tab, 1);
    clock.t += 200;
    // The agent's own pointerdown: consumed, NOT attributed to a human.
    expect(manager.noteHumanInput("s", { tab })).toBe(false);
    // Past the coarse attribution grace, with nothing left expected: a real
    // hand, and it wins. (Inside the grace the agent's own echo is assumed.)
    clock.t += 500; // > HUMAN_ATTRIBUTION_GRACE_MS (400)
    expect(manager.noteHumanInput("s", { tab })).toBe(true);
  });

  test("a destroyed scope leaves nothing keyed by it behind", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 800, height: 600 });
    manager.stampAgentInput(manager.activeTab("s"), 1);
    expect(manager.diagnostics().scopeEntries).toBeGreaterThan(0);

    manager.releaseScope("s", true);

    expect(manager.diagnostics()).toMatchObject({ scopes: 0, tabs: 0, scopeEntries: 0 });
    expect(manager.scopeProfiles.has("s")).toBe(false);
    expect(manager.scopeProjects.has("s")).toBe(false);
    expect(manager.boundsByScope.has("s")).toBe(false);
    expect(manager.lastAgentInputAt.has("s")).toBe(false);
  });

  test("a release that is not a destroy keeps the scope's binding — its tabs are only asleep", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");

    manager.releaseScope("s");

    expect(manager.profileOf("s")).toBe("none");
    expect(manager.scopeTabs("s")).toHaveLength(1);
    expect(manager.diagnostics()).toMatchObject({ tabs: 1, liveViews: 0 });
  });

  test("adopting a scope's tabs forgets the scope they came from", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("from", "none");
    await manager.createTab("from", "https://one.example/");
    manager.setBounds("from", { x: 0, y: 0, width: 800, height: 600 });

    manager.adoptScope("from", "to");

    expect(manager.scopeTabs("to")).toHaveLength(1);
    expect(manager.profileOf("to")).toBe("none");
    // The source is over: its binding used to stay for the life of the process
    // and keep the dead scope inside emitAllStates' loop.
    expect(manager.scopeProfiles.has("from")).toBe(false);
    expect(manager.scopeProjects.has("from")).toBe(false);
    expect(manager.boundsByScope.has("from")).toBe(false);
    expect(manager.diagnostics().scopes).toBe(1);
  });

  test("the inventory is walked once per turn, not once per page event", async () => {
    let walks = 0;
    const { manager } = makeHarness();
    manager.tabStore = { load: () => null, save: () => {}, flushSync: () => {} };
    await manager.createTab("s", "https://one.example/");
    const inventory = manager.inventory.bind(manager);
    manager.inventory = () => { walks += 1; return inventory(); };

    // One page's burst — a load, a title, a favicon, an in-page navigation —
    // used to be one full walk of every tab of every scope each.
    const wc = manager.activeTab("s").view.webContents;
    wc.emit("did-start-loading");
    wc.emit("page-title-updated", {}, "One");
    wc.emit("page-favicon-updated", {}, ["https://one.example/f.ico"]);
    wc.emit("did-navigate-in-page");
    wc.emit("did-stop-loading");
    expect(walks).toBe(0); // nothing walked synchronously

    await Promise.resolve();
    expect(walks).toBe(1);
  });
});

/**
 * DUPLICATE — the tab strip's own verb (#274), and the one action in the human
 * list that reads a tab rather than writing one.
 */
describe("duplicating a tab", () => {
  test("it opens a second tab at the same address, and the source is left exactly where it was", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");

    await manager.action("s", { action: "duplicate", index: 0 });

    const tabs = manager.state("s").tabs;
    expect(tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/", "https://one.example/"]);
    // A duplicate is a NEW tab, not a second handle on the old one.
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
    // Opened by the person, so it takes the screen the way their own New tab
    // does — which is the whole difference between this and an agent's tab.
    expect(tabs[2].active).toBe(true);
    expect(tabs[2].openedBy).toBe("human");
  });

  test("with no index it duplicates the tab you are looking at", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await manager.selectTab("s", 0);

    await manager.action("s", { action: "duplicate" });

    expect(manager.state("s").tabs.map((tab) => tab.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
      "https://one.example/",
    ]);
  });

  test("it duplicates where the tab IS, not where its record last said it was", async () => {
    // The two differ for exactly as long as a navigation is in flight, which
    // is precisely when somebody duplicates a tab to keep the page they had.
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    views[0].webContents.url = "https://one.example/deep/page";

    await manager.action("s", { action: "duplicate", index: 0 });
    expect(manager.state("s").tabs[1].url).toBe("https://one.example/deep/page");
  });

  test("an index that names no tab is refused, rather than duplicating something else", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await expect(manager.action("s", { action: "duplicate", index: 9 })).rejects.toThrow(/does not exist/);
    expect(manager.state("s").tabs).toHaveLength(1);
  });
});

/**
 * WHICH WINDOW'S BROWSER AN AGENT'S SCOPE MEANS (issue #311).
 *
 * Two windows, two hosts — what "Open in a new window" (#310) builds. A panel
 * request carries its sender and is answered by that window; the agent-facing
 * control server carries only a SCOPE, and used to be answered by one global.
 * These are the fixture's two windows standing in for that.
 */
describe("the agent's scope finds its own window's browser", () => {
  const windows = () => {
    const one = makeHarness().manager;
    const two = makeHarness().manager;
    return { one, two, set: new Set([one, two]) };
  };
  const PANEL = { x: 0, y: 0, width: 800, height: 600 };

  test("no window claims the scope: the window the human is in answers, as it always did", async () => {
    const { one, two, set } = windows();
    // Another session's pages in window one must not make it session-a's window.
    await one.createTab("session-b", "https://b.example/");
    expect(managerForScope(set, "session-a", two)).toBe(two);
    expect(managerForScope(set, "session-a", one)).toBe(one);
  });

  test("the session's panel is in the second window: that window answers, whichever one is focused", async () => {
    const { one, two, set } = windows();
    two.setBounds("session-a", PANEL);
    await two.setVisible("session-a", true);
    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("live pages are a claim of their own, for a session no panel is mounted for", async () => {
    const { one, two, set } = windows();
    await two.createTab("session-a", "https://a.example/");
    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("a panel showing the session outranks another window's live pages of it", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    two.setBounds("session-a", PANEL);
    await two.setVisible("session-a", true);
    // The human is in window one AND its host holds pages; the browser they are
    // looking at is still the one in window two, and that is the one to drive.
    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("a second Browser panel tab is the same session: `S` finds the window holding `S#2`", async () => {
    // Since #334 a second Browser tab drives `${sessionId}#${instanceId}` and
    // only the first keeps the bare session id — the one the engine drives.
    const { one, two, set } = windows();
    two.setBounds("session-a#browser-2", PANEL);
    await two.setVisible("session-a#browser-2", true);
    expect(managerForScope(set, "session-a", one)).toBe(two);
    // The WINDOW is all that was resolved: the sibling's scope key is not a
    // stand-in for the session's own, and its pages stay its own.
    expect(two.state("session-a").tabs).toEqual([]);
  });

  test("but an instance-qualified scope never borrows the window of its session", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    expect(managerForScope(set, "session-a#browser-2", two)).toBe(two);
  });

  test("an exact scope outranks a sibling instance with a stronger claim", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    two.setBounds("session-a#browser-2", PANEL);
    await two.setVisible("session-a#browser-2", true);
    expect(managerForScope(set, "session-a", two)).toBe(one);
  });

  test("two windows with an equal claim: the window the human is in breaks the tie", () => {
    const { one, two, set } = windows();
    one.setBounds("session-a", PANEL);
    two.setBounds("session-a", PANEL);
    expect(managerForScope(set, "session-a", one)).toBe(one);
    expect(managerForScope(set, "session-a", two)).toBe(two);
  });

  test("a remembered tab is not a claim — every window's host restores the same inventory", async () => {
    const { manager: source } = makeHarness();
    const saved = [];
    source.tabStore = { load: () => null, save: (doc) => saved.push(doc), flushSync: () => {} };
    await source.createTab("session-a", "https://a.example/");
    await Promise.resolve(); // the inventory walk is coalesced to a microtask
    const doc = saved.at(-1);

    const reopen = () => {
      const window = { isDestroyed: () => false, webContents: { send: () => {} }, contentView: { addChildView: () => {}, removeChildView: () => {} } };
      const manager = new DesktopBrowserManager(window, {
        createId: () => "x",
        createView: () => new FakeView(),
        wait: async () => {},
        profiles: source.profiles,
        tabStore: { load: () => doc, save: () => {}, flushSync: () => {} },
      });
      manager.ensureAutoRelease = () => {};
      return manager;
    };
    const one = reopen();
    const two = reopen();
    // Both remember the page, so counting remembered tabs would hand the scope
    // to whichever window was built first — today's bug with a new global.
    expect(one.state("session-a").tabs).toHaveLength(1);
    expect(two.state("session-a").tabs).toHaveLength(1);
    expect(one.scopeClaim("session-a")).toBe(0);
    expect(managerForScope(new Set([one, two]), "session-a", two)).toBe(two);
  });

  test("a closed window's host claims nothing, and an empty scope claims nowhere", async () => {
    const { one, two, set } = windows();
    await two.createTab("session-a", "https://a.example/");
    two.destroy();
    expect(two.scopeClaim("session-a")).toBe(0);
    expect(managerForScope(set, "session-a", one)).toBe(one);
    expect(one.scopeClaim("")).toBe(0);
    expect(one.scopeClaim(null)).toBe(0);
  });
});

describe("the page's context menu and its DevTools (#423)", () => {
  test("a right-click on the page pops a native menu built from Chromium's params", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const menu = rightClick(harness, harness.views[0]);
    expect(menu.popups).toBe(1);
    expect(menu.template.map((entry) => entry.label ?? "—")).toEqual([
      "Back",
      "Forward",
      "Reload",
      "—",
      "View Page Source",
      "Inspect",
    ]);
  });

  test("Inspect opens DevTools DETACHED, on the element under the pointer", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    pick(rightClick(harness, harness.views[0], { x: 120, y: 240 }), "Inspect");
    // Detached: a docked DevTools would split the viewport the geometry
    // pipeline has just finished placing.
    expect(wc.devToolsOptions).toEqual({ mode: "detach" });
    expect(wc.inspected).toEqual([{ x: 120, y: 240 }]);
    expect(harness.manager.state("session-a").tabs[0].devtools).toBe(true);
  });

  test("DevTools are the TAB'S and close with it — never a window left addressing nothing", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    await harness.manager.createTab("session-a", "https://other.example");
    const [first, second] = harness.views;
    pick(rightClick(harness, first), "Inspect");
    expect(first.webContents.isDevToolsOpened()).toBe(true);
    // Per tab: the second tab's own state is untouched.
    expect(harness.manager.state("session-a").tabs.map((tab) => tab.devtools)).toEqual([true, false]);
    harness.manager.closeTab("session-a", 0, "human");
    expect(first.webContents.isDevToolsOpened()).toBe(false);
    expect(second.webContents.isDevToolsOpened()).toBe(false);
  });

  test("⌥⌘I toggles DevTools for the tab the human is looking at, and does nothing with no tab", async () => {
    const harness = makeHarness();
    // No tab at all: the command is answered with silence, not an error.
    harness.manager.declareProfile("session-a", "none");
    expect((await harness.manager.action("session-a", { action: "toggle-devtools" })).tabs).toEqual([]);

    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    await harness.manager.action("session-a", { action: "toggle-devtools" });
    expect(wc.isDevToolsOpened()).toBe(true);
    // No inspect point — the chord is "show me the tools", not "inspect this".
    expect(wc.inspected).toEqual([]);
    await harness.manager.action("session-a", { action: "toggle-devtools" });
    expect(wc.isDevToolsOpened()).toBe(false);
  });

  test("DevTools stay out of the agent's reach — performAction refuses the id", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    await expect(harness.manager.performAction("session-a", { action: "toggle-devtools" })).rejects.toThrow(
      "Unknown desktop browser action",
    );
    expect(harness.views[0].webContents.isDevToolsOpened()).toBe(false);
  });

  test("a devtools window the person closed themselves is a state push", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    pick(rightClick(harness, harness.views[0]), "Inspect");
    const before = harness.messages.length;
    wc.closeDevTools();
    expect(harness.messages.length).toBeGreaterThan(before);
    expect(harness.messages.at(-1).payload.tabs[0].devtools).toBe(false);
  });

  test("a link's new tab goes through the ordinary open-tab path, as the human's", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "https://example.com/other" }), "Open Link in New Tab");
    await harness.manager.settlePopupTabs();
    const tabs = harness.manager.state("session-a").tabs;
    expect(tabs).toHaveLength(2);
    // The strip, the inventory and #383's rules are the same as the + button's.
    expect(tabs[1]).toMatchObject({ url: "https://example.com/other", openedBy: "human", active: true });
  });

  test("Copy Link writes the link, not the page", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "https://example.com/other" }), "Copy Link");
    expect(harness.clipboard.text).toBe("https://example.com/other");
  });

  test("a link the popup rule refuses opens NOTHING, silently", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "javascript:alert(1)" }), "Open Link in New Tab");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs).toHaveLength(1);
  });

  test("View Page Source opens a view-source: tab on the page", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0]), "View Page Source");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs[1].url).toBe("view-source:https://example.com/");
  });

  test("a selection ALWAYS searches, even when it reads like an address", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { selectionText: "example.org" }), "Search the web for “example.org”");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs[1].url).toBe("https://www.google.com/search?q=example.org");
  });

  test("the edit verbs and the spelling fix reach the page's own WebContents", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    const editable = { isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive"] };
    pick(rightClick(harness, harness.views[0], editable), "receive");
    pick(rightClick(harness, harness.views[0], { isEditable: true }), "Paste");
    pick(rightClick(harness, harness.views[0], { hasImageContents: true, srcURL: "https://example.com/cat.png", x: 5, y: 7 }), "Copy Image");
    pick(rightClick(harness, harness.views[0], { hasImageContents: true, srcURL: "https://example.com/cat.png" }), "Save Image As…");
    expect(wc.edits).toEqual(["replace:receive", "paste", "copy-image:5,7"]);
    expect(wc.downloads).toEqual(["https://example.com/cat.png"]);
  });

  test("a right-click is a human's hand on the tab before any row is picked", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const tab = harness.manager.state("session-a").tabs[0];
    expect(tab.controller).not.toBe("human");
    rightClick(harness, harness.views[0]);
    expect(harness.manager.state("session-a").tabs[0].controller).toBe("human");
  });
});

describe("view-source: is the one non-web scheme the tabs render", () => {
  test("it wraps an ordinary web page, and refuses anything else", () => {
    expect(normalizeUrl("view-source:https://example.com/a")).toBe("view-source:https://example.com/a");
    expect(normalizeUrl("view-source:http://localhost:3000/")).toBe("view-source:http://localhost:3000/");
    // Never a local file, and never a ladder of itself.
    expect(() => normalizeUrl("view-source:file:///etc/passwd")).toThrow("only views the source of http and https");
    expect(() => normalizeUrl("view-source:view-source:https://example.com/")).toThrow("only views the source of http and https");
    expect(() => normalizeUrl("view-source:not a url")).toThrow("only views the source of http and https");
  });
});
