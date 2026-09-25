const { EventEmitter } = require("node:events");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager, managerForScope, normalizeUrl, looksLikeAddress, zoomStep, ZOOM_STEPS, TAB_SELECT_CHORDS } = require("./browser-manager");

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
    // The options menu's page-level verbs (#473): which reloads were asked
    // for, and the zoom factor the menu reads back.
    this.reloads = [];
    this.zoomFactor = 1;
    // The frozen frame's capture seam (#475) — see `capturePage`.
    this.captures = [];
    this.captureGate = null;
    this.captureError = null;
    this.captureEmpty = false;
    this.view = null;
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
    this.windowOpenHandler = null;
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

  /** dom-ready's first act; a no-op here, recorded nowhere. */
  setBackgroundThrottling() {}

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  /**
   * `window.open`, as much of Chromium's half of it as the manager's handler
   * meets (#615). The guest WebContents is built FIRST and handed to
   * `createWindow` — that ordering is the whole fix, because the guest is what
   * carries the opener edge — and Chromium, not the handler, navigates it once
   * the handler has answered. `opener` here stands in for that edge: a real
   * `window.opener` cannot exist without a renderer, so the relationship is
   * asserted against real Electron in browser-popup.electron-test.js and only
   * PLUMBED here.
   */
  openWindow(url, details = {}) {
    if (!this.windowOpenHandler) return { action: "allow" };
    const response = this.windowOpenHandler({
      url,
      frameName: "",
      features: "",
      disposition: "new-window",
      ...details,
    });
    if (response?.action !== "allow" || typeof response.createWindow !== "function") return response;
    const guest = new FakeWebContents();
    guest.opener = this;
    guest.session = this.session;
    response.adopted = response.createWindow({ webContents: guest, webPreferences: {} });
    guest.loadURL(new URL(url).href);
    return response;
  }

  /**
   * A hidden view's capture path (see DesktopBrowserManager.screenshot), and
   * the frozen frame's (#475): Electron's NativeImage, narrowed to what the
   * manager reads.
   *
   * EVERY CALL RECORDS WHETHER ITS VIEW WAS STILL SHOWN, which is how the
   * capture-before-hide order is pinned without an Electron. `captureGate`
   * holds a capture open (a never-settling one is the ceiling's case),
   * `captureError` makes it fail, `captureEmpty` makes it answer a blank
   * frame.
   */
  async capturePage(rect) {
    this.captures.push({ visibleAtCapture: this.view ? this.view.visible : null, ...(rect ? { rect } : {}) });
    if (this.captureGate) await this.captureGate;
    if (this.captureError) throw this.captureError;
    return {
      isEmpty: () => Boolean(this.captureEmpty),
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

  reload() {
    this.reloads.push("reload");
  }

  // "Hard reload" is a DIFFERENT call, not a flag on the same one — recorded
  // separately so a test can tell a cache bypass from an ordinary reload.
  reloadIgnoringCache() {
    this.reloads.push("reload-ignoring-cache");
  }

  setZoomFactor(factor) {
    this.zoomFactor = factor;
  }

  getZoomFactor() {
    return this.zoomFactor;
  }

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
  /** `webContents` present means ADOPTION — Electron's
   *  `new WebContentsView({ webContents })`, the popup path (#615). */
  constructor(options = {}) {
    this.webContents = options.webContents || new FakeWebContents();
    // The capture records whether its own view was still shown (#475).
    this.webContents.view = this;
    this.visible = false;
    this.bounds = null;
    // Every radius this view was TOLD, in order — the manager writes only on
    // a change, so the list is the claim, not the last value.
    this.radii = [];
    // And every canvas colour, the same way: the page's opaque base, or none.
    this.canvases = [];
  }

  setBackgroundColor(color) {
    this.canvases.push(color);
  }

  /** Electron 36+. Recorded rather than performed. */
  setBorderRadius(radius) {
    this.radii.push(radius);
  }

  setVisible(visible) {
    this.visible = visible;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }
}

/**
 * A tab's own window (#473), as much of one as `openPreview` touches: a
 * `contentView` to re-parent the view into, a content size for the rect, the
 * two events the manager listens for, and a `destroy` that emits `closed` the
 * way Electron's does — which is what makes "the person closed the window" a
 * thing a test can do.
 */
class FakePreviewWindow {
  constructor(options = {}) {
    this.options = options;
    this.destroyed = false;
    this.focused = 0;
    this.children = new Set();
    this.listeners = new Map();
    this.contentView = {
      addChildView: (view) => this.children.add(view),
      removeChildView: (view) => this.children.delete(view),
    };
  }

  getContentSize() {
    return [this.options.width, this.options.height];
  }

  on(event, listener) {
    const bound = this.listeners.get(event) || [];
    bound.push(listener);
    this.listeners.set(event, bound);
    return this;
  }

  emit(event) {
    for (const listener of this.listeners.get(event) || []) listener();
  }

  focus() {
    this.focused += 1;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

function makeHarness(options = {}) {
  const views = [];
  const messages = [];
  const waits = [];
  const children = new Set();
  // Every window `openPreview` opened, newest last.
  const previewWindows = [];
  // Per partition, the Chromium session "Clear cookies"/"Clear cache" reach.
  // OPT-IN (options.sessions): handing every test a live session would send
  // them all through `preparePartition`'s permission install.
  const sessions = new Map();
  const sessionFor = (partition) => {
    if (!sessions.has(partition)) {
      sessions.set(partition, {
        partition,
        storageCleared: [],
        cachesCleared: 0,
        async clearStorageData(input) { this.storageCleared.push(input); },
        async clearCache() { this.cachesCleared += 1; },
        // `preparePartition` installs the #422 handlers on any session it can
        // reach; accepted and ignored, so this stays a fixture for clearing
        // rather than a second permissions harness.
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setDisplayMediaRequestHandler() {},
        setDevicePermissionHandler() {},
      });
    }
    return sessions.get(partition);
  };
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
    // The one more Electron seam the options menu needs (#473).
    BrowserWindow: class extends FakePreviewWindow {
      constructor(windowOptions) {
        super(windowOptions);
        previewWindows.push(this);
      }
    },
  });
  /**
   * THE COCKPIT'S OWN ZOOM (#895) — the View menu's, not a page's. The rect
   * the renderer publishes is in CSS pixels of this zoomed window, so it is
   * the factor `setBounds` is scaled by. `setCockpitZoom` moves it and fires
   * the `zoom-changed` Electron emits for a wheel zoom.
   */
  const cockpitZoom = { factor: options.cockpitZoom || 1, listeners: [] };
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => messages.push({ channel, payload }),
      getZoomFactor: () => cockpitZoom.factor,
      on: (event, listener) => {
        if (event === "zoom-changed") cockpitZoom.listeners.push(listener);
      },
    },
    contentView: {
      addChildView: (view) => children.add(view),
      removeChildView: (view) => children.delete(view),
    },
  };
  const setCockpitZoom = (factor) => {
    cockpitZoom.factor = factor;
    for (const listener of cockpitZoom.listeners) listener();
  };
  const manager = new DesktopBrowserManager(window, {
    electron,
    createId: () => `tab-${nextId++}`,
    createView: (viewOptions = {}) => {
      const view = new FakeView(viewOptions);
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
    ...(options.onChordScope ? { onChordScope: options.onChordScope } : {}),
    ...(options.onLoginEntryFinished ? { onLoginEntryFinished: options.onLoginEntryFinished } : {}),
    ...(options.tabStore ? { tabStore: options.tabStore } : {}),
    ...(options.sessions ? { sessionFor } : {}),
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
  return { children, clipboard, manager, menus, messages, previewWindows, sessions, setCockpitZoom, views, waits };
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

  test("opens target-blank web links as managed browser tabs, adopting Chromium's own popup", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://one.example/", "human");

    // ALLOW, not deny (#615). Denying and re-opening the URL ourselves is what
    // severed `window.opener`; the tab must be Chromium's popup, adopted.
    const response = views[0].webContents.openWindow("https://popup.example/path");
    expect(response.action).toBe("allow");
    // The guest is what the manager hosted — not a second WebContents of its
    // own, which is the only way the opener edge survives.
    expect(response.adopted).toBe(views[1].webContents);
    expect(views[1].webContents.opener).toBe(views[0].webContents);
    // And it must outlive its opener: hibernating a tab closes its
    // WebContents, and Electron's default would take the popup with it.
    expect(response.outlivesOpener).toBe(true);
    await manager.settlePopupTabs();

    const state = manager.state("session-a");
    expect(state.tabs.map((tab) => [tab.url, tab.active, tab.agentFocus, tab.openedBy])).toEqual([
      ["https://one.example/", false, false, "human"],
      ["https://popup.example/path", true, true, "human"],
    ]);
  });

  test("a popup keeps the OPENER's profile, not whichever one the session switched to", async () => {
    const { manager, views } = makeHarness();
    manager.declareProfile("session-a", `project_${"a".repeat(32)}`);
    await manager.createTab("session-a", "https://one.example/", "human");
    const opener = manager.scopeTabs("session-a")[0];
    // The person switches this session's profile while the sign-in is open.
    // Already-open tabs keep their identity (setScopeProfile aims the NEXT
    // one) — and a popup belongs to the page that asked for it, not to "next".
    const other = manager.profiles.create({ label: "Personal" });
    manager.setScopeProfile("session-a", other.id);

    views[0].webContents.openWindow("https://popup.example/oauth");
    await manager.settlePopupTabs();

    const popup = manager.scopeTabs("session-a")[1];
    expect(popup.partition).toBe(opener.partition);
    expect(popup.profileId).toBe(opener.profileId);
    expect(popup.partition).not.toBe(manager.partitionOf("session-a"));
  });

  test("a popup past the per-session tab limit is refused, and opens nothing", async () => {
    const { manager, views } = makeHarness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("session-a", `https://tab${i}.example/`, "human");

    expect(views[0].webContents.openWindow("https://popup.example/oauth")).toEqual({ action: "deny" });
    await manager.settlePopupTabs();

    expect(manager.state("session-a").tabs).toHaveLength(12);
  });

  test("keeps agent-triggered popups off the human's current browser tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://human.example/", "human");
    await manager.createTab("session-a", "https://agent.example/", "agent");
    const agentTab = manager.scopeTabs("session-a")[1];
    agentTab.agentBusy = 1;

    expect(views[1].webContents.openWindow("https://popup.example/oauth").action).toBe("allow");
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

  test("snapshot narrows to a ref's subtree, and refuses a ref it never minted", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    // The ref has to be resolved against the PREVIOUS snapshot's refs, which
    // the next render clears — the one ordering subtlety in `snapshot`.
    expect(textOf(await manager.callTool("session-a", "browser_snapshot"))).toContain('button "Count 0" [ref=e1]');
    const narrowed = await manager.callTool("session-a", "browser_snapshot", { target: "e1" });
    expect(narrowed.isError).toBeUndefined();
    // Only the addressed subtree, with the ref minted fresh inside it.
    expect(textOf(narrowed)).toContain('button "Count 0" [ref=e1]');
    // The page header stays (it says WHERE the region is); the document root
    // above the addressed node does not.
    expect(textOf(narrowed)).toContain("Page: Fixture");
    expect(textOf(narrowed)).not.toContain("- RootWebArea");
    expect(textOf(await manager.callTool("session-a", "browser_snapshot"))).toContain("- RootWebArea");
    // The ref still works afterwards: the re-mint is what keeps it usable.
    expect((await manager.callTool("session-a", "browser_click", { target: "e1" })).isError).toBeUndefined();

    // A ref from no snapshot is named, not quietly widened to the document.
    await manager.callTool("session-a", "browser_snapshot");
    const unknown = await manager.callTool("session-a", "browser_snapshot", { target: "e404" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown browser target e404");
  });

  test("snapshot depth stops at a level; console level is a floor the host now honours", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    // depth 0 is the root alone — the button is one level down.
    const shallow = await manager.callTool("session-a", "browser_snapshot", { depth: 0 });
    expect(textOf(shallow)).toContain("Fixture");
    expect(textOf(shallow)).not.toContain("Count 0");
    expect(textOf(await manager.callTool("session-a", "browser_snapshot", { depth: 1 }))).toContain("Count 0");

    const tab = manager.scopeTabs(manager.requireScope("session-a"))[0];
    tab.console.push({ level: "debug", text: "chatter" }, { level: "error", text: "boom" });
    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { level: "error" }))).toBe("[error] boom");
    // The schema has defaulted to "info" since the tool shipped; the host used
    // to answer with everything regardless.
    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { level: "info" }))).not.toContain("chatter");
    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { all: true }))).toContain("chatter");
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

/**
 * THE LOCK-DOWN THAT IS GONE (#524). A person entering credentials used to
 * pause EVERY agent browser tool in EVERY session until a focus-aware probe
 * said the entry was over — and when a page would not answer that probe, the
 * browser was dead in every session at once with no way out but killing Telar.
 * The feature is removed, not softened: there is no flag and no degraded mode.
 *
 * What a login entry still does is tell the login offer about itself, and
 * nothing else. What is still refused is an EXTENSION PAGE — a password
 * manager's popup or unlock is not a page an agent reads — which is a rule
 * about the target, not about what a person is doing.
 */
describe("a sign-in never pauses a browser tool", () => {
  test("a tool call during a credential entry returns the tool's own result", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s1", "https://login.example");
    await manager.createTab("s2", "https://two.example");
    // The whole of what used to lock the browser down: the extension popup is
    // open, and the page's preload reports a value landing in a password field.
    manager.addUiHold("p:popup", "1Password");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "fill" });
    for (const [scope, name, args] of [["s1", "browser_snapshot", {}], ["s2", "browser_snapshot", {}], ["s1", "browser_click", { target: "e1" }], ["s2", "browser_take_screenshot", {}], ["s1", "browser_console_messages", {}], ["s2", "browser_tabs", { action: "list" }]]) {
      const result = await manager.callTool(scope, name, args);
      expect(result.isError).toBeUndefined();
    }
    // And a console line from the page is captured, not dropped on the floor.
    await manager.ensureDebugger(manager.activeTab("s1"));
    views[0].webContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "still logging" }] });
    expect(manager.activeTab("s1").console).toHaveLength(1);
  });

  test("the state the renderer reads carries no pause to draw", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://login.example");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "fill" });
    expect(manager.state("s").privacy).toBeUndefined();
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

/**
 * THE COCKPIT'S CAMERA (#474) — `capture`, which the address row's camera
 * button and the annotate overlay's frozen frame both go through.
 *
 * WHAT THESE PIN is the one thing a screenshot under a fit scale gets wrong:
 * the SCALE. A page laid out at 1280×800 inside a 640px column must come back
 * 1280×800, because the overlay draws on those pixels and a person marking up
 * a third-size frame in the corner of a blank one is the bug.
 */
describe("the cockpit's own capture", () => {
  test("a fixed tab under a 0.5 fit scale is captured at the tab's own scale, not the panel's", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.resizeTab(manager.activeTab("s"), { preset: "default" });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The panel is showing it at half size...
    expect(manager.state("s").presentation.scale).toBe(0.5);
    const shot = await manager.capture("s");
    // ...and the capture is the INTRINSIC page: an explicit scale-1 clip at
    // the tab's own viewport, which is what travels back with the image.
    const clip = views[0].webContents.debugger.commands.filter((c) => c.method === "Page.captureScreenshot").at(-1);
    expect(clip.params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 }, captureBeyondViewport: true, fromSurface: true });
    expect(shot).toMatchObject({ data: "cG5n", mimeType: "image/png", url: "https://one.example/", width: 1280, height: 800, fullPage: false });
  });

  test("it reads the HUMAN's active tab, never the agent's", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    // A tab the agent opened and works in; the human stays on the first.
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
    // Not asked for, not gathered — the camera button pays for no DOM walk.
    expect((await manager.capture("s")).elements).toBeUndefined();
  });

  test("a blank tab and an empty scope are refused with a sentence, not an empty PNG", async () => {
    const { manager } = makeHarness();
    await expect(manager.capture("s")).rejects.toThrow(/no page here/i);
    await manager.createTab("s", "about:blank");
    await expect(manager.capture("s")).rejects.toThrow(/no page loaded/i);
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
   * DELETE NEVER STRANDS A SESSION (#430). On a machine used before shared
   * profiles, every old profile had tabs somewhere, so refusing on a tab meant
   * Delete could never succeed. It moves the tabs instead.
   */
  describe("deleteProfile — forgetting a profile moves what was browsing in it", () => {
    test("a session with tabs in the profile moves to the default, and its tabs sleep there with their URLs", async () => {
      const { manager } = makeHarness();
      const fallback = manager.profiles.get(manager.profiles.defaultProfileId);
      const work = manager.profiles.create({ label: "Work" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", work.id);
      await manager.createTab("s", "https://one.example");
      await manager.createTab("s", "https://two.example");

      const removed = manager.deleteProfile(work.id);

      expect(removed).toMatchObject({ id: work.id, label: "Work", sessions: 1, tabs: 2 });
      expect(manager.profiles.get(work.id)).toBeNull();
      expect(manager.scopeProfiles.get("s")).toBe(fallback.id);
      expect(manager.scopeProfileOverrides.has("s")).toBe(false);
      const tabs = manager.scopeTabs("s");
      expect(tabs.map((tab) => tab.view)).toEqual([null, null]);
      expect(tabs.every((tab) => tab.profileId === fallback.id && tab.partition === fallback.partition)).toBe(true);
      expect(tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/"]);
    });

    test("a tab left in the profile after its session switched away is re-homed in the session's current profile", async () => {
      const { manager } = makeHarness();
      const old = manager.profiles.create({ label: "Old" });
      const next = manager.profiles.create({ label: "Next" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", old.id);
      await manager.createTab("s", "https://one.example");
      manager.setScopeProfile("s", next.id);

      expect(manager.deleteProfile(old.id)).toMatchObject({ sessions: 1, tabs: 1 });
      expect(manager.scopeProfiles.get("s")).toBe(next.id);
      expect(manager.scopeTabs("s")[0]).toMatchObject({ profileId: next.id, partition: next.partition, view: null });
    });

    test("a remembered session's hibernated tabs move too, and the saved inventory names a profile that exists", () => {
      let saved;
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
          save: (inventory) => { saved = inventory; },
          flushSync: () => {},
        },
      });
      const spare = manager.profiles.create({ label: "Spare" });
      manager.profiles.setDefault(spare.id);
      const restored = manager.scopeTabs("s1")[0].profileId;

      expect(manager.deleteProfile(restored)).toMatchObject({ sessions: 1, tabs: 1 });
      expect(manager.scopeTabs("s1")[0].profileId).toBe(spare.id);
      expect(manager.scopeProfiles.get("s1")).toBe(spare.id);
      return Promise.resolve().then(() => {
        expect(JSON.stringify(saved)).not.toContain(restored);
      });
    });

    test("the default is still refused, and nothing moves", async () => {
      const { manager } = makeHarness();
      const fallback = manager.profiles.get(manager.profiles.defaultProfileId);
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await manager.createTab("s", "https://one.example");
      expect(() => manager.deleteProfile(fallback.id)).toThrow("Make another profile the default first.");
      expect(manager.scopeTabs("s")[0].view).not.toBeNull();
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

  test("fitViewport scales down to fit, centres across and top-aligns, never scales up", () => {
    expect(fitViewport({ width: 1280, height: 800 }, { x: 10, y: 20, width: 640, height: 400 })).toEqual({ scale: 0.5, rect: { x: 10, y: 20, width: 640, height: 400 } });
    // A stage taller than the fitted page: the page starts at the stage's
    // top, as a device toolbar shows a screen — not centred over a band.
    expect(fitViewport({ width: 1280, height: 800 }, { x: 0, y: 0, width: 640, height: 600 })).toEqual({ scale: 0.5, rect: { x: 0, y: 0, width: 640, height: 400 } });
    expect(fitViewport({ width: 390, height: 844 }, { x: 0, y: 30, width: 1000, height: 900 })).toEqual({ scale: 1, rect: { x: 305, y: 30, width: 390, height: 844 } });
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
    // Same intrinsic viewport; only the presentation scale changes — and the
    // page's widget stays the VIEW's size, not the override's: without
    // `dontSetVisibleSize` Chromium grows it to 1280×800 past the view, a
    // white slab below the page once the canvas is opaque.
    expect(shown.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 0.5, dontSetVisibleSize: true });
    expect(debug.commands.filter((c) => c.method === "Emulation.setVisibleSize").at(-1).params).toEqual({ width: 640, height: 400 });
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

    // The drag: the panel's left edge moves, the stage keeps its size.
    manager.setBounds("s", { x: 20, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;
    manager.setBounds("s", { x: 40, y: 0, width: 640, height: 400 });
    await tab.geometry.queue;

    // TWO frames placed, one `setBounds` each — the run returns before the
    // trailing re-assert, because there is no emulation in flight to wait for.
    expect(placements).toBe(2);
    expect(view.bounds).toEqual({ x: 40, y: 0, width: 640, height: 400 });
    // Nothing downstream ran: no fit-viewport write, no CDP at all.
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

    // A SHORTER stage: a fixed tab's presentation scale changes with it (this
    // tall phone is height-bound), so the emulation target moved and the pass
    // is owed.
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;

    expect(syncs).toBe(1);
    expect(overrides()).toBe(before + 1);
    expect(debug.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toMatchObject({ width: 390, height: 844 });
  });
});

describe("the recorded emulation never outlives the real one (#917)", () => {
  /**
   * A FIXED tab shown in a narrow panel with its emulation settled — the one
   * state the drag fast path is allowed to trust, and so the one state in
   * which a record that outlived Chromium's override used to stick forever.
   * 1280×800 into 640×400 is scale 0.5, the whole panel.
   */
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
    // Chromium ended the session: its overrides went with it.
    debug.attached = false;
    debug.emit("detach", {}, "target closed");
    expect(tab.debuggerReady).toBe(false);
    expect(tab.viewportOverride).toBeUndefined();
    expect(manager.emulationSettled(tab)).toBe(false);
    // The renderer's self-heal republish: the SAME stage, no fit change — the
    // frame the fast path used to answer with one setBounds and no CDP.
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
    // The old debugger's detach arrives late, as a closing WebContents' does.
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
    // The person closes the window by its own button: the same edge.
    wc.closeDevTools();
    await tab.geometry.queue;
    expect(overrides().length).toBe(before + 2);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    // The view itself never moved: the same fitted rect throughout.
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
    // A shorter stage moves the fit scale (0.5 → 0.375), so a new emulation
    // is owed — and refused.
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;
    expect(refusals).toBe(1);
    expect(tab.viewportOverride).toBe("1280x800@0.5 in 640x400");
    expect(manager.emulationSettled(tab)).toBe(false);
    // The republish of the same bounds is not a fast-path frame while the
    // record is unsettled.
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 300 });
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.375 });
    expect(tab.viewportOverride).toBe("1280x800@0.375 in 480x300");
  });

  test("suspect 3, ruled out: a cockpit zoom change alone re-sends a fixed tab's emulation with the zoom in its scale", async () => {
    const { setCockpitZoom, tab, overrides, views } = await settledFixedTab();
    const before = overrides().length;
    // A wheel zoom: the factor moved, the panel published nothing.
    setCockpitZoom(0.9);
    await tab.geometry.queue;
    expect(overrides().length).toBe(before + 1);
    expect(Math.abs(overrides().at(-1).params.scale - 0.45)).toBeLessThan(1e-9);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 576, height: 360 });
    expect(tab.viewportOverride).toBe("1280x800@0.45 in 576x360");
  });

  test("suspect 4, ruled out: a fixed tab hidden and shown again — panel closed, or another tab in front — is re-emulated at the shown scale", async () => {
    const { manager, tab, overrides, views } = await settledFixedTab();
    // The panel closes: the hidden emulation is the intrinsic size at scale 1.
    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(views[0].visible).toBe(false);
    // It reopens on the same rect: the reveal runs the whole pass, not a placement.
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expect(overrides().at(-1).params).toMatchObject({ width: 1280, height: 800, scale: 0.5 });
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
    // Another tab in front (the human's, so it takes the screen), then this
    // one again.
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
    // THE RENDERER'S UNITS DO NOT MOVE: `bounds` and the rect the panel reads
    // back stay the CSS pixels it published, or the device frame and the
    // frozen frame would be drawn at the zoomed numbers.
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

    // ⌘− with the panel open: the factor moved, the rect did not.
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
    // 390×844 fitted into 640×400 is scale 400/844 → a 185×400 rect, centred
    // at x=227 in the panel's own pixels; the window's are those × 0.9.
    expect(views[0].bounds).toEqual({ x: 204, y: 0, width: 167, height: 360 });
    const last = views[0].webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1);
    expect(last.params).toMatchObject({ width: 390, height: 844 });
    // Without the zoom in the scale the page would render 185 wide into a
    // 167-wide view and lose its right edge.
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
    // The orchestrator's call, exactly as the engine now forwards it.
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

describe("a fixed tab's view is exactly the emulated page — bounds and emulation cannot disagree, and the page is top-aligned", () => {
  /** The rectangle the page renders into (viewport × the scale last sent)
   *  against the rectangle the view was given. Chromium lays the page out
   *  at the emulated size whatever the view's size is, so any difference
   *  here is either page painted outside the frame or a strip of nothing
   *  inside it. */
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
    // The owner's stage: wider than tall for the standard page, so the fit
    // is width-bound and the stage has room left under the page.
    manager.setBounds("s", { x: 12, y: 40, width: 858, height: 790 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    // Fit: the view IS the stage, nothing emulated.
    expect(view.bounds).toEqual({ x: 12, y: 40, width: 858, height: 790 });
    expect(tab.viewportOverride).toBe("native");

    await manager.resizeTab(tab, { preset: "default" });
    await tab.geometry.queue;
    // 1280×800 at 858/1280: 858×536, at the TOP of the stage (y: 40, not
    // 40 + 127) — a device toolbar's screen, not a page floating mid-panel.
    expectAgreed(view, { x: 12, y: 40, width: 858, height: 536 });
    expect(manager.state("s").presentation).toMatchObject({ mode: "fixed", rect: { x: 12, y: 40, width: 858, height: 536 } });
    expect(Math.abs(manager.state("s").presentation.scale - 858 / 1280)).toBeLessThan(1e-9);

    // The renderer, now in fixed mode, republishes the stage inside its
    // resize rails (12px off each axis). The view follows the smaller fit
    // and so does the emulation — a full pass, not the drag fast path.
    manager.setBounds("s", { x: 12, y: 40, width: 846, height: 778 });
    await tab.geometry.queue;
    expectAgreed(view, { x: 12, y: 40, width: 846, height: 529 });

    // A tall preset in the same stage: height-bound, centred across, top-aligned.
    await manager.resizeTab(tab, { preset: "phone" });
    await tab.geometry.queue;
    expectAgreed(view, { x: 255, y: 40, width: 360, height: 778 });

    // The cockpit's own zoom rides both the bounds and the emulation scale.
    await manager.resizeTab(tab, { preset: "default" });
    setCockpitZoom(0.9);
    await tab.geometry.queue;
    expectAgreed(view, { x: 11, y: 36, width: 761, height: 476 });
  });

  test("a hidden fixed tab is emulated at its own size, and shown again in a taller stage it is placed at the top, agreed", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");
    const view = views[0];
    await manager.resizeTab(tab, { preset: "default" });
    // Never shown: no bounds written, emulated at its own size, scale 1.
    expect(view.bounds).toBeNull();
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 600 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expectAgreed(view, { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", false);
    await tab.geometry.queue;
    expect(view.webContents.debugger.commands.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").at(-1).params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    expectAgreed(view, { x: 0, y: 0, width: 640, height: 400 });
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
    // Attached with no canvas: the first document has no frame yet, and an
    // opaque underlay there is the white strip transparency was introduced for.
    expect(view.canvases).toEqual([NONE]);
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    // The first document, edge by edge (the fake's loadURL fires them all at
    // once): loading — the view is shown for it — then committed, still no
    // canvas; dom-ready is the edge that paints it.
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
    // A claim, not a pulse: later placements and dom-readys write nothing.
    manager.setBounds("s", { x: 0, y: 0, width: 900, height: 500 });
    await tab.geometry.queue;
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE]);
    // The next page keeps it, the way a browser keeps its own canvas
    // between documents — no dark flash between two light pages.
    await manager.navigateTab(tab, "https://two.example/");
    expect(view.canvases).toEqual([NONE, WHITE]);
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE]);
    // Blank again (the page navigated itself to about:blank): the DOM start
    // page is drawn under this view, so the canvas goes with the document.
    await wc.loadURL("about:blank");
    await tab.geometry.queue;
    expect(view.visible).toBe(false);
    expect(view.canvases).toEqual([NONE, WHITE, NONE]);
    // about:blank's own dom-ready is no document.
    wc.emit("dom-ready");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE, NONE]);
    // THE BELT: a document that finished loading without this process seeing
    // its dom-ready (a back/forward-cache restore fires none) is still a
    // document to paint on.
    await wc.loadURL("https://three.example/");
    await tab.geometry.queue;
    expect(view.canvases).toEqual([NONE, WHITE, NONE, WHITE]);
    // A renderer that went away took its document with it: the cockpit shows
    // through until a reload, not a white rectangle where the page was.
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
    // Hold the new WebContents' load open so the fresh view can be seen
    // before its document is ready.
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
  test("onVisited fires for a committed http(s) top-level navigation only: not blank, not an error status, not an extension page", async () => {
    const visited = [];
    const { manager, views } = makeHarness({ onVisited: (scopeKey, url) => visited.push([scopeKey, url]) });
    await manager.createTab("s", "https://one.example/");
    const wc = views[0].webContents;
    wc.url = "https://two.example/path"; wc.emit("did-navigate", null, "https://two.example/path", 200);
    wc.url = "https://err.example/"; wc.emit("did-navigate", null, "https://err.example/", 404);
    wc.url = "chrome-extension://abc/x.html"; wc.emit("did-navigate", null, "chrome-extension://abc/x.html", 200);
    wc.url = "about:blank"; wc.emit("did-navigate", null, "about:blank", 0);
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
 * #475 — THE PAGE FILLS THE PANEL, AND STAYS PUT BEHIND A MENU.
 *
 * Two complaints, one shape: the native view is composited ABOVE the cockpit's
 * DOM, so neither the panel's rounded corner nor a menu drawn over it means
 * anything to it. The corner it has to be TOLD (the renderer publishes it with
 * the rect, because a CSS token is not something the main process can read),
 * and the menu it has to be taken down for — which is what made the page blink
 * out on every ⋯, and what the frozen frame replaces.
 */
describe("the panel's corner, and the frozen frame a menu opens over", () => {
  /** A visible scope showing one real page in a real panel rect. */
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

    // The renderer republishes the SAME rect as its self-heal, on every
    // layout change and every frame of a panel animation. Re-rounding there
    // would be a compositor change per frame for nothing.
    const written = view.radii.length;
    manager.setBounds("s", { x: 12, y: 40, width: 640, height: 400, radius: 14 });
    await manager.activeTab("s").geometry.queue;
    expect(view.radii.length).toBe(written);

    // A device toolbar publishes 0: a fixed viewport's stage is centred
    // inside a padded host and never reaches the panel's corner.
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

  /**
   * THE ORDER IS THE WHOLE POINT, and it is why freezing is one call rather
   * than a capture the renderer follows with a hide. A view that is already
   * down has no compositor frame to give — asking it for one is the blink
   * this exists to remove, with a stall on top.
   */
  test("the capture finishes while the page is still shown, and the hide follows it", async () => {
    const { manager, tab, view } = await shown({ radius: 14 });
    let release;
    tab.view.webContents.captureGate = new Promise((resolve) => { release = resolve; });

    const freezing = manager.freezeView("s");
    await Promise.resolve();
    // Cropped to the view's own size: a widget larger than its view must not
    // come back as the page shrunk into a corner of a bigger frame.
    expect(tab.view.webContents.captures).toEqual([{ visibleAtCapture: true, rect: { x: 0, y: 0, width: 640, height: 400 } }]);
    expect(view.visible).toBe(true);

    release();
    const frame = await freezing;
    expect(frame).toEqual({
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/png",
      // The view's own rect, in the window coordinates `setBounds` was given,
      // so the renderer can paint the frame exactly where the page was.
      rect: { x: 12, y: 40, width: 640, height: 400 },
    });
    expect(view.visible).toBe(false);
  });

  test("a capture that outruns the ceiling hides plainly, the way it did before the frame existed", async () => {
    const { manager, tab, view } = await shown({ radius: 14 });
    // A page that never answers: the menu still has to open.
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
// on (the tab leaving the page the value was typed into). The offer's own
// decisions are covered in login-offer.test.js and login-offer-flow.test.js.
describe("the login offer capture", () => {
  test("an entry captures the tab's address and identity; focus captures nothing", async () => {
    const clock = { t: 50_000 };
    const { manager, views } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://accounts.example.com/signin?next=/inbox");
    const wc = views[0].webContents;

    manager.noteLoginEntryFromWebContents(wc, { kind: "focus" });
    expect(manager.heldLoginCapture).toBeNull();

    manager.noteLoginEntryFromWebContents(wc, { kind: "fill" });
    expect(manager.heldLoginCapture).toMatchObject({
      origin: "https://accounts.example.com",
      tabUid: manager.scopeTabs("s")[0].id,
      at: 50_000,
    });
    expect(manager.heldLoginCapture.profileId).toBeTruthy();
  });

  test("the capture is taken AT ENTRY and a later navigation does not move it", async () => {
    const finished = [];
    const { manager, views } = makeHarness({ onLoginEntryFinished: (capture) => finished.push(capture) });
    await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });
    // The sign-in redirects; the capture handed on still names the typed-into
    // page, not where the redirect landed.
    await views[0].webContents.loadURL("https://mail.example.com/u/0");
    expect(finished.at(-1)?.origin ?? manager.heldLoginCapture.origin).toBe("https://accounts.example.com");
  });

  test("leaving the page hands the capture on, once", async () => {
    const finished = [];
    const { manager, views } = makeHarness({ onLoginEntryFinished: (capture) => finished.push(capture) });
    const tab = await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });
    // Nothing is asked while the person is still on the form.
    expect(finished.length).toBe(0);
    manager.noteNavigation(tab);
    expect(finished.length).toBe(1);
    expect(finished[0].origin).toBe("https://accounts.example.com");
    expect(manager.heldLoginCapture).toBeNull();
    // A later navigation with nothing held hands nothing on.
    manager.noteNavigation(tab);
    expect(finished.length).toBe(1);
  });

  test("a page that cannot carry a grant is never captured", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });
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
 * ISSUE #487. What the runaway-worker watchdog asks the manager: which origins
 * still have a page on screen, per partition. Everything else about the
 * decision is pure and lives in service-worker-watchdog.test.js.
 */
describe("the origins with a live page, per partition (#487)", () => {
  test("a live tab's origin answers for its partition; a hibernated one does not", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://github.com/facundo/telar");
    await manager.createTab("s", "https://www.youtube.com/watch?v=1");
    const partition = manager.partitionOf("s");

    expect(manager.liveOriginsByPartition().get(partition)).toEqual(
      new Set(["https://github.com", "https://www.youtube.com"]),
    );

    // THE WHOLE POINT: the page closes, the worker does not. A hibernated tab
    // must stop vouching for its origin or every runaway looks busy.
    manager.requestHibernate(manager.scopeTabs("s")[0]);
    expect(manager.liveOriginsByPartition().get(partition)).toEqual(new Set(["https://www.youtube.com"]));

    manager.requestHibernate(manager.scopeTabs("s")[1]);
    expect(manager.liveOriginsByPartition().has(partition)).toBe(false);
  });

  test("a page with no origin of its own vouches for nothing", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "about:blank");
    expect(manager.liveOriginsByPartition().size).toBe(0);
  });

  test("the partitions to walk include one whose every tab has hibernated", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://github.com/");
    const partition = manager.partitionOf("s");
    manager.requestHibernate(manager.scopeTabs("s")[0]);
    // No live view left, and that is exactly the partition whose workers are
    // still running — it must not drop out of the walk.
    expect(manager.activePartitions().has(partition)).toBe(true);
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

/**
 * THE OPTIONS MENU'S OWN VERBS (#473).
 *
 * The panel gained one `⋯` menu holding what a browser keeps behind one:
 * hard reload, DevTools, a window of its own, appearance, zoom, the profile,
 * and clearing this profile's cookies or cache. DevTools already had #423's
 * tests above; the rest are here.
 *
 * ALL OF THEM ARE THE HUMAN'S, which is why they live on `action` beside
 * `toggle-devtools` rather than in `performAction`: zoom and appearance change
 * what the page lays out as, and an agent's snapshot then describes a layout
 * nobody asked it to choose.
 */
describe("the browser's options menu", () => {
  test("the zoom ladder is Chromium's, and it stops at both ends", () => {
    expect(zoomStep(1, "in")).toBe(1.1);
    expect(zoomStep(1, "out")).toBe(0.9);
    expect(zoomStep(1, "reset")).toBe(1);
    // A factor BETWEEN rungs lands on the next real one either way, so a zoom
    // set by the page (or by an older ladder) still steps sensibly.
    expect(zoomStep(1.2, "in")).toBe(1.25);
    expect(zoomStep(1.2, "out")).toBe(1.1);
    // Clamped: the ends are rungs, not a wrap-around and not an error.
    expect(zoomStep(ZOOM_STEPS.at(-1), "in")).toBe(ZOOM_STEPS.at(-1));
    expect(zoomStep(ZOOM_STEPS[0], "out")).toBe(ZOOM_STEPS[0]);
    // Reset from anywhere is 1, including from a factor off the ladder.
    expect(zoomStep(3.7, "reset")).toBe(1);
    expect(() => zoomStep(1, "sideways")).toThrow("Unknown zoom direction");
  });

  test("zoom walks the ladder on the page itself, and the panel reads it back", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const wc = views[0].webContents;

    await manager.action("session-a", { action: "zoom", direction: "in" });
    expect(wc.getZoomFactor()).toBe(1.1);
    expect(manager.state("session-a").tabs[0].zoom).toBe(1.1);

    await manager.action("session-a", { action: "zoom", direction: "in" });
    expect(manager.state("session-a").tabs[0].zoom).toBe(1.25);
    await manager.action("session-a", { action: "zoom", direction: "reset" });
    expect(wc.getZoomFactor()).toBe(1);
    expect(manager.state("session-a").tabs[0].zoom).toBe(1);
  });

  test("a zoomed tab is still zoomed after it is hibernated and woken", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const tab = manager.scopeTabs("session-a")[0];
    await manager.action("session-a", { action: "zoom", direction: "out" });
    expect(views[0].webContents.getZoomFactor()).toBe(0.9);

    // A new WebContents starts at 1; the geometry pipeline is what puts the
    // tab's own factor back, the same way it re-applies the viewport.
    manager.requestHibernate(tab);
    await manager.wakeTab(tab);
    await manager.applyGeometry(tab);
    expect(views.at(-1).webContents.getZoomFactor()).toBe(0.9);
    expect(manager.state("session-a").tabs[0].zoom).toBe(0.9);
  });

  test("hard reload is a cache bypass, not the ordinary reload with a flag", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const wc = views[0].webContents;

    await manager.action("session-a", { action: "reload" });
    await manager.action("session-a", { action: "hard-reload" });
    expect(wc.reloads).toEqual(["reload", "reload-ignoring-cache"]);
    // Both are the human's hand on the tab, so an agent defers.
    expect(manager.state("session-a").tabs[0].controller).toBe("human");
  });

  test("appearance emulates prefers-color-scheme, and system clears the override", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const debug = views[0].webContents.debugger;
    const media = () => debug.commands.filter((entry) => entry.method === "Emulation.setEmulatedMedia");

    // A FRESH PAGE EMULATES NOTHING, which is what "system" already means:
    // asserting it would be a round trip to change nothing.
    expect(media()).toEqual([]);

    await manager.action("session-a", { action: "appearance", scheme: "dark" });
    expect(media().at(-1).params).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] });
    expect(manager.state("session-a").tabs[0].colorScheme).toBe("dark");

    await manager.action("session-a", { action: "appearance", scheme: "system" });
    // Now there IS something to clear, so the empty feature list is sent.
    expect(media().at(-1).params).toEqual({ features: [] });
    expect(manager.state("session-a").tabs[0].colorScheme).toBe("system");

    await expect(manager.action("session-a", { action: "appearance", scheme: "sepia" })).rejects.toThrow("Unknown appearance");
  });

  test("appearance is re-applied to a tab's NEW WebContents, not lost with the old one", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const tab = manager.scopeTabs("session-a")[0];
    await manager.action("session-a", { action: "appearance", scheme: "dark" });

    manager.requestHibernate(tab);
    await manager.wakeTab(tab);
    await manager.applyGeometry(tab);
    const media = views.at(-1).webContents.debugger.commands.filter((entry) => entry.method === "Emulation.setEmulatedMedia");
    expect(media.at(-1).params).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] });
  });

  describe("a tab in a window of its own", () => {
    /** A visible scope with one page and a real panel rect — the state a
     *  person is looking at when they reach for "open a separate window". */
    async function shown() {
      const harness = makeHarness();
      await harness.manager.createTab("session-a", "https://example.com");
      harness.manager.setBounds("session-a", { x: 0, y: 0, width: 900, height: 600 });
      await harness.manager.setVisible("session-a", true);
      return harness;
    }

    test("the LIVE view moves out of the cockpit — a preview is the tab, not a copy of it", async () => {
      const { children, manager, previewWindows, views } = await shown();
      expect(children.has(views[0])).toBe(true);

      await manager.action("session-a", { action: "preview" });
      const window = previewWindows.at(-1);
      // One page, one place: out of the cockpit's tree and into the new
      // window's. A second WebContents would be a different page.
      expect(views).toHaveLength(1);
      expect(children.has(views[0])).toBe(false);
      expect(window.children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(true);
    });

    test("it is sized to the page's own viewport and fills its window", async () => {
      const { manager, previewWindows, views } = await shown();
      // Fit mode adopted the 900×600 stage before the preview.
      expect(manager.state("session-a").tabs[0].viewport).toMatchObject({ width: 900, height: 600 });

      await manager.action("session-a", { action: "preview" });
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(previewWindows.at(-1).options).toMatchObject({ width: 900, height: 600, useContentSize: true });
      expect(views[0].visible).toBe(true);
      expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    test("the panel neither places nor hides a previewed tab — its own window would go blank", async () => {
      const { manager, views } = await shown();
      await manager.action("session-a", { action: "preview" });

      // Every path that hides a view for the panel's sake: another scope
      // becoming visible, this one being taken away, a fresh bounds publish.
      await manager.setVisible("session-a", false);
      manager.setBounds("session-a", { x: 0, y: 0, width: 400, height: 300 });
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(views[0].visible).toBe(true);
      // And it keeps ITS OWN viewport rather than adopting a stage it left.
      expect(manager.state("session-a").tabs[0].viewport).toMatchObject({ width: 900, height: 600 });
    });

    test("closing the window is how the tab comes back", async () => {
      const { children, manager, previewWindows, views } = await shown();
      await manager.action("session-a", { action: "preview" });
      const window = previewWindows.at(-1);

      window.destroy(); // the person clicked the window's own close button
      expect(children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(false);
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    test("the panel can bring it back too, and asking twice only focuses the window", async () => {
      const { children, manager, previewWindows, views } = await shown();
      await manager.action("session-a", { action: "preview" });
      await manager.action("session-a", { action: "preview" });
      expect(previewWindows).toHaveLength(1);
      expect(previewWindows[0].focused).toBe(1);

      await manager.action("session-a", { action: "end-preview" });
      expect(previewWindows[0].isDestroyed()).toBe(true);
      expect(children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(false);
    });

    test("closing the TAB takes its window with it — never a window addressing nothing", async () => {
      const { manager, previewWindows } = await shown();
      await manager.action("session-a", { action: "preview" });
      manager.closeTab("session-a", 0, "human");
      expect(previewWindows[0].isDestroyed()).toBe(true);
    });

    test("an agent cannot open a window over the person's screen", async () => {
      const { manager, previewWindows } = await shown();
      await expect(manager.performAction("session-a", { action: "preview" })).rejects.toThrow("Unknown desktop browser action");
      expect(previewWindows).toHaveLength(0);
    });
  });

  describe("clearing this profile's cookies and cache", () => {
    test("the scope is the PARTITION — the whole identity, which is what the panel's confirm says", async () => {
      const { manager, sessions } = makeHarness({ sessions: true });
      await manager.createTab("session-a", "https://example.com");
      const partition = manager.scopeTabs("session-a")[0].partition;

      expect(await manager.clearBrowsingData("session-a", "cookies")).toMatchObject({ ok: true, kind: "cookies", partition });
      expect(sessions.get(partition).storageCleared).toEqual([{ storages: ["cookies"] }]);
      expect(sessions.get(partition).cachesCleared).toBe(0);

      expect(await manager.clearBrowsingData("session-a", "cache")).toMatchObject({ ok: true, kind: "cache", partition });
      expect(sessions.get(partition).cachesCleared).toBe(1);
      // The cookies call is not repeated by the cache one.
      expect(sessions.get(partition).storageCleared).toHaveLength(1);
    });

    test("it refuses what it cannot do rather than reporting a clear that did not happen", async () => {
      const { manager } = makeHarness({ sessions: true });
      manager.declareProfile("session-a", "none");
      // No tab: there is no partition to name, so there is nothing to clear.
      await expect(manager.clearBrowsingData("session-a", "cookies")).rejects.toThrow("no tab here");

      await manager.createTab("session-a", "https://example.com");
      await expect(manager.clearBrowsingData("session-a", "history")).rejects.toThrow("Unknown browsing data");
    });

    test("with no Chromium session to reach it says so — never a silent success", async () => {
      // The default harness injects no `sessionFor`, which is the unit layer's
      // "there is no Electron here".
      const { manager } = makeHarness();
      await manager.createTab("session-a", "https://example.com");
      await expect(manager.clearBrowsingData("session-a", "cookies")).rejects.toThrow("no Chromium session");
    });
  });
});

/**
 * #660: ⌘1..⌘9 SELECT A TAB WHILE THE PAGE HAS THE KEYS.
 *
 * The half the cockpit renderer cannot do. A keydown on a focused
 * `WebContentsView` never reaches that renderer — native focus is in another
 * process — so both the claim that stands the menu down and the handler that
 * answers the key live here. These drive the real `webContents` events.
 */
describe("a focused page owns ⌘1..⌘9 (#660)", () => {
  /** A key headed for the page, shaped like Electron's `before-input-event`. */
  function press(view, key, modifiers = { meta: true }) {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    view.webContents.emit("before-input-event", event, { type: "keyDown", key, alt: false, shift: false, control: false, meta: false, ...modifiers });
    return prevented;
  }

  async function withTabs(count) {
    const scopes = [];
    const harness = makeHarness({ onChordScope: (chords) => scopes.push(chords) });
    harness.manager.declareProfile("s1", "none");
    for (let n = 0; n < count; n += 1) await harness.manager.createTab("s1", `https://${n}.example/`, "human");
    return { ...harness, scopes };
  }

  test("focus claims the nine and blur gives them back — the menu only stands down while a page holds them", async () => {
    const { manager, views, scopes } = await withTabs(2);
    expect(scopes).toEqual([]); // Merely having tabs claims nothing.

    views[0].webContents.emit("focus");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);

    views[0].webContents.emit("blur");
    expect(scopes.at(-1)).toEqual([]);
    // Claiming on MOUNT would have left the rail's ⌘1..⌘9 dead for as long as
    // the panel was open, which is the bug this shape exists to avoid.
    expect(manager.keyFocusedTabId).toBeNull();
  });

  test("⌘2 selects the second tab and the page never sees the key", async () => {
    const { manager, views } = await withTabs(3);
    await manager.selectTab("s1", 0);
    views[0].webContents.emit("focus");

    expect(press(views[0], "2")).toBe(true);
    await Promise.resolve();
    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(1);
  });

  test("⌃2 works too, and a digit past the last tab is left for the page", async () => {
    const { manager, views } = await withTabs(2);
    await manager.selectTab("s1", 0);

    expect(press(views[0], "2", { control: true })).toBe(true);
    await Promise.resolve();
    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(1);

    // ⌘7 with two tabs open must reach the page rather than vanish.
    expect(press(views[0], "7")).toBe(false);
  });

  test("⌥⌘1, ⇧⌘1, a bare 1 and a keyUp are all somebody else's", async () => {
    const { manager, views } = await withTabs(3);
    await manager.selectTab("s1", 2);
    for (const input of [{ meta: true, alt: true }, { meta: true, shift: true }, {}]) {
      expect(press(views[0], "1", input)).toBe(false);
    }
    let prevented = false;
    views[0].webContents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { type: "keyUp", key: "1", meta: true });
    expect(prevented).toBe(false);
    // Nothing moved the human's view.
    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(2);
  });

  test("a second tab taking focus does not let the first one's late blur release the claim", async () => {
    const { views, scopes } = await withTabs(2);
    views[0].webContents.emit("focus");
    // Chromium delivers focus to the new view before blurring the old one on
    // some paths; the stale blur must not hand back keys the new page holds.
    views[1].webContents.emit("focus");
    views[0].webContents.emit("blur");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);
  });

  test("closing the focused tab releases the claim — a destroyed page emits no blur", async () => {
    const { manager, views, scopes } = await withTabs(2);
    views[1].webContents.emit("focus");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);
    manager.closeTab("s1", 1, "human");
    // A leak here leaves the rail's shortcut dead with no way back but a restart.
    expect(scopes.at(-1)).toEqual([]);
  });
});

/**
 * A PAGE DRAWN ON A CANVAS has no refs for what the screenshot shows, so the
 * acting tools also take the screenshot's CSS pixels, type into whatever has
 * focus, take chords, and paste/copy through the page's own clipboard events.
 * The fake page answers the in-page reads from `page`: what sits at a point,
 * the focused editable, and what the paste/copy events came back with.
 */
describe("acting on a page with no refs — coordinates, focus, chords, paste and copy", () => {
  const { keyChord } = require("./browser-manager");

  async function canvasTab({ mode = "fixed", page = {} } = {}) {
    const harness = makeHarness();
    const { manager, views } = harness;
    await manager.createTab("s", "https://sheet.example/");
    const tab = manager.activeTab("s");
    if (mode === "fixed") {
      // The narrow-panel case: 1280×800 shown in 640×400 → scale 0.5.
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
    // A look at the page is what licenses acting on it.
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
    // The system clipboard is never the route.
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

  /**
   * THE IN-PAGE SCRIPTS THEMSELVES, run against a small fake DOM: the copy
   * fallback to a textarea's selected range and to the document selection,
   * and the focus walk into a frame's contenteditable body (where a canvas
   * spreadsheet keeps focus).
   */
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

/**
 * THE WHITE SLAB UNDER A FIXED PAGE (after #922). `setDeviceMetricsOverride`
 * without `dontSetVisibleSize` has Chromium resize the page's render widget to
 * the override's own width×height (`WebContentsImpl::SetDeviceEmulationSize`)
 * — 1280×800 in a view given 975×609. The page is drawn scaled into that
 * widget's corner and the rest is canvas, overflowing the view to the window's
 * edge: invisible while the canvas was transparent, white once it was opaque,
 * and the whole oversized surface is what a frozen frame captured. A fake
 * cannot paint, so these pin the commands; the Electron fit-zoom suite
 * samples the pixels.
 */
describe("a fixed page's widget is the view's size, never the override's", () => {
  // The owner's panel: the Default preset in a stage taller than the page.
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
    // Top-aligned, full width, only as tall as the scaled page.
    expect(rect).toEqual({ x: 8, y: 120, width: 975, height: 609 });
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
    // A hidden page needs a real widget for its captures and input.
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
    // The rect stays in the panel's CSS pixels — what the renderer paints in.
    expect(frame.rect).toEqual({ x: 8, y: 120, width: 975, height: 609 });
  });
});
