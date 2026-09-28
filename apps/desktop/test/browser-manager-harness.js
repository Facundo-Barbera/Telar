const { EventEmitter } = require("node:events");

const { DesktopBrowserManager } = require("../src/browser/browser-manager");
const { installDownloadHandler } = require("../src/browser/browser-downloads");

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

    this.reloads = [];
    this.zoomFactor = 1;

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

  setBackgroundThrottling() {}

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

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

  reloadIgnoringCache() {
    this.reloads.push("reload-ignoring-cache");
  }

  setZoomFactor(factor) {
    this.zoomFactor = factor;
  }

  getZoomFactor() {
    return this.zoomFactor;
  }

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
  constructor(options = {}) {
    this.webContents = options.webContents || new FakeWebContents();

    this.webContents.view = this;
    this.visible = false;
    this.bounds = null;

    this.radii = [];

    this.canvases = [];
  }

  setBackgroundColor(color) {
    this.canvases.push(color);
  }

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

  const previewWindows = [];

  const sessions = new Map();
  const sessionFor = (partition) => {
    if (!sessions.has(partition)) {
      sessions.set(partition, {
        partition,
        storageCleared: [],
        cachesCleared: 0,
        async clearStorageData(input) { this.storageCleared.push(input); },
        async clearCache() { this.cachesCleared += 1; },

        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setDisplayMediaRequestHandler() {},
        setDevicePermissionHandler() {},

        downloadListeners: [],
        on(event, listener) { if (event === "will-download") this.downloadListeners.push(listener); },
        download(item, webContents) { for (const listener of this.downloadListeners) listener({}, item, webContents); },
      });
    }
    return sessions.get(partition);
  };
  let nextId = 1;

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

    BrowserWindow: class extends FakePreviewWindow {
      constructor(windowOptions) {
        super(windowOptions);
        previewWindows.push(this);
      }
    },
  });

  const cockpitZoom = { factor: options.cockpitZoom || 1, listeners: [] };

  const movedListeners = [];
  const moveWindow = () => { for (const listener of movedListeners) listener(); };
  const window = {
    isDestroyed: () => false,
    on: (event, listener) => {
      if (event === "moved") movedListeners.push(listener);
    },
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
    ...(options.timers ? { setTimer: options.timers.set, clearTimer: options.timers.clear } : {}),
    ...(options.scaleFactor ? { scaleFactor: options.scaleFactor } : {}),
    ...(options.sessions ? { sessionFor } : {}),

    downloadsPath: () => "/fixture/Downloads",
    installDownloads: (ses, handlers) => installDownloadHandler(ses, { ...handlers, fs: { existsSync: () => false, mkdirSync() {} } }),
  });

  const origCreate = manager.createTab.bind(manager);
  manager.createTab = (scopeKey, ...rest) => {
    if (scopeKey && !manager.profileOf(scopeKey)) manager.declareProfile(scopeKey, "none");
    return origCreate(scopeKey, ...rest);
  };
  return { children, clipboard, manager, menus, messages, moveWindow, previewWindows, sessions, setCockpitZoom, views, waits };
}

function textOf(result) {
  return (result.content || []).map((part) => part.text || "").join("\n");
}

module.exports = { FakeView, makeHarness, textOf };
