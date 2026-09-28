const { mock } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(listener);
    return this;
  }
  once(event, listener) {
    return this.on(event, listener);
  }
  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeWebContents extends Emitter {
  constructor(url = "") {
    super();
    this.mainFrame = { name: "main" };
    this.url = url;
    this.sent = [];
    this.windowOpenHandler = null;
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
}

class FakeBrowserWindow extends Emitter {
  static all = [];
  static focused = null;
  static getAllWindows() {
    return FakeBrowserWindow.all.filter((win) => !win.destroyed);
  }
  static getFocusedWindow() {
    return FakeBrowserWindow.focused;
  }
  static fromWebContents(contents) {
    return FakeBrowserWindow.all.find((win) => win.webContents === contents) ?? null;
  }
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.title = options.title;
    this.loaded = [];
    FakeBrowserWindow.all.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return false;
  }
  isMinimized() {
    return false;
  }
  setTitle(title) {
    this.title = title;
  }
  loadURL(url) {
    this.loaded.push(url);
    this.webContents.url = url;
  }
  setVibrancy(material) {
    this.vibrancy = material;
  }
  setBackgroundColor(color) {
    this.backgroundColor = color;
  }
  show() {}
  focus() {
    FakeBrowserWindow.focused = this;
    this.emit("focus");
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

const ipcMain = {
  handlers: new Map(),
  listeners: new Map(),
  handle(channel, handler) {
    this.handlers.set(channel, handler);
  },
  on(channel, listener) {
    this.listeners.set(channel, listener);
  },
  invoke(channel, event, ...args) {
    return this.handlers.get(channel)(event, ...args);
  },
  send(channel, event, ...args) {
    return this.listeners.get(channel)(event, ...args);
  },
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fake-electron-"));

const electron = {
  app: Object.assign(new Emitter(), {
    isPackaged: false,
    isQuitting: false,
    quits: 0,
    switches: [],
    commandLine: { appendSwitch: (...args) => electron.app.switches.push(args) },
    paths: {},
    name: "Telar",
    getPath: () => userData,
    setPath: (name, value) => { electron.app.paths[name] = value; },
    setName: (name) => { electron.app.name = name; },
    getName: () => "Telar",
    getVersion: () => "0.0.0-test",
    quit: () => { electron.app.quits += 1; },
  }),
  BrowserWindow: FakeBrowserWindow,
  contextBridge: { exposed: {}, exposeInMainWorld: (name, api) => { electron.contextBridge.exposed[name] = api; } },
  dialog: {
    shown: [],
    showErrorBox: (title, detail) => electron.dialog.shown.push({ kind: "error", title, detail }),
    showMessageBoxSync: (options) => { electron.dialog.shown.push({ kind: "message", ...options }); return 0; },
  },
  ipcMain,
  ipcRenderer: Object.assign(new Emitter(), {
    invoked: [],
    invoke: (channel, payload) => { electron.ipcRenderer.invoked.push([channel, payload]); return Promise.resolve(); },
    removeListener: (channel, listener) => {
      const listeners = electron.ipcRenderer.listeners.get(channel) ?? [];
      electron.ipcRenderer.listeners.set(channel, listeners.filter((candidate) => candidate !== listener));
    },
  }),
  Menu: { buildFromTemplate: (template) => template, setApplicationMenu: (menu) => { electron.Menu.current = menu; } },
  nativeTheme: Object.assign(new Emitter(), { shouldUseDarkColors: false, themeSource: "system" }),
  powerMonitor: Object.assign(new Emitter(), { getSystemIdleState: () => "active" }),
  session: { defaultSession: { cookies: { set: async () => {} }, webRequest: { onBeforeSendHeaders() {} } }, fromPartition: () => ({}) },
  shell: { opened: [], openExternal: (url) => { electron.shell.opened.push(url); return Promise.resolve(); }, showItemInFolder: (target) => electron.shell.opened.push(target) },
  webContents: { getAllWebContents: () => [] },
};

mock.module("electron", () => electron);

/** Clears what a test recorded; the module mock itself stays for the whole run. */
function resetElectron() {
  FakeBrowserWindow.all = [];
  FakeBrowserWindow.focused = null;
  ipcMain.handlers.clear();
  ipcMain.listeners.clear();
  electron.shell.opened = [];
  electron.dialog.shown = [];
  electron.app.quits = 0;
  electron.app.isQuitting = false;
  electron.app.switches = [];
  electron.app.paths = {};
  electron.app.name = "Telar";
  electron.app.isPackaged = false;
  electron.nativeTheme.shouldUseDarkColors = false;
  for (const emitter of [electron.app, electron.nativeTheme, electron.powerMonitor]) emitter.listeners.clear();
}

/** An IPC event from `win`'s top frame, or from somewhere else when `sender`/`frame` say so. */
function eventFrom(win, { sender = win.webContents, frame = win.webContents.mainFrame } = {}) {
  return { sender, senderFrame: frame };
}

module.exports = { electron, eventFrom, FakeBrowserWindow, FakeWebContents, resetElectron, userData };
