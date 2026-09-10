// The REAL window wiring (login-offer-window.js) under a mocked Electron:
// the same wireLoginOffer main.js calls, with the module's own installed IPC
// handlers invoked directly — so sender/top-frame rejection, navigation
// refusal, window lockdown and the grant round-trip are asserted through the
// production code path, not through the pure helper alone. Vault metadata is
// fake; the grant root is a temp directory read back with the ENGINE's store.
const { describe, expect, test, mock } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class FakeWebContents {
  constructor() {
    this.mainFrame = {};
    this.listeners = new Map();
    this.windowOpenHandler = null;
    this.sent = [];
  }
  on(event, listener) {
    this.listeners.set(event, listener);
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

class FakeBrowserWindow {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.closedListeners = [];
    this.loadedFile = null;
    this.focused = 0;
    FakeBrowserWindow.instances.push(this);
  }
  loadFile(file) {
    this.loadedFile = file;
  }
  once(event, listener) {
    if (event === "closed") this.closedListeners.push(listener);
  }
  focus() {
    this.focused += 1;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.closedListeners) listener();
  }
}

const fakeIpcMain = {
  handlers: new Map(),
  handle(channel, handler) {
    this.handlers.set(channel, handler);
  },
};

// Installed BEFORE the module under test resolves "electron". No other unit
// test resolves electron, so the mock leaks nowhere.
mock.module("electron", () => ({ BrowserWindow: FakeBrowserWindow, ipcMain: fakeIpcMain }));
const { wireLoginOffer } = require("./login-offer-window");
const { captureEntry } = require("./login-offer");
const engine = require("../engine/src/secrets/login-grants.ts");

const capture = (over = {}) =>
  captureEntry({
    kind: "input",
    origin: "https://accounts.example.com/signin",
    profileId: "profile_1",
    profileLabel: "Personal",
    tabUid: "tab_7",
    at: Date.now(),
    ...over,
  });

const CANDIDATES = {
  ok: true,
  candidates: [
    { id: "item_work", title: "Example — work", domain: "example.com", vault: "Private" },
    { id: "item_home", title: "Example — home", domain: "example.com", vault: "Private" },
  ],
};

function harness({ listCandidates } = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-login-offer-window-"));
  const offer = wireLoginOffer({ stateRoot, listCandidates: listCandidates || (async () => CANDIDATES) });
  const window = () => FakeBrowserWindow.instances.at(-1);
  const trusted = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const invoke = (channel, event, input) => fakeIpcMain.handlers.get(channel)(event, input);
  return { stateRoot, offer, window, trusted, invoke };
}

describe("the wired offer window", () => {
  test("is locked down: local file, isolated renderer, no navigation, no popups", () => {
    const { offer, window } = harness();
    offer.entryFinished(capture());
    const win = window();
    expect(path.basename(win.loadedFile)).toBe("login-offer.html");
    expect(win.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(path.basename(win.options.webPreferences.preload)).toBe("login-offer-preload.js");
    // The installed will-navigate listener refuses every navigation…
    let prevented = false;
    win.webContents.listeners.get("will-navigate")({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    // …and the installed open handler denies every popup.
    expect(win.webContents.windowOpenHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
    win.close();
  });

  test("every installed handler refuses a sender that is not the window's own top frame", async () => {
    const { offer, window, invoke } = harness();
    offer.entryFinished(capture());
    const win = window();
    const foreign = { sender: new FakeWebContents(), senderFrame: {} }; // another renderer
    const subframe = { sender: win.webContents, senderFrame: {} }; // right window, not its top frame
    for (const channel of ["telar:login-offer:state", "telar:login-offer:confirm", "telar:login-offer:dismiss"]) {
      expect(fakeIpcMain.handlers.has(channel)).toBe(true);
      for (const event of [foreign, subframe]) {
        expect(() => invoke(channel, event, {})).toThrow("Only the login offer window may use this channel.");
      }
    }
    win.close();
  });

  test("the trusted round-trip: state → confirm writes a grant the ENGINE store finds, then the window closes", async () => {
    const { stateRoot, offer, window, trusted, invoke } = harness();
    offer.entryFinished(capture());
    const win = window();
    const shown = await invoke("telar:login-offer:state", trusted(win));
    expect(shown.origin).toBe("https://accounts.example.com");
    expect(shown.profileLabel).toBe("Personal");
    expect(shown.candidates.map((candidate) => candidate.id)).toEqual(["item_work", "item_home"]);

    const result = await invoke("telar:login-offer:confirm", trusted(win), { itemId: "item_home", otp: true });
    expect(result.ok).toBe(true);
    expect(win.destroyed).toBe(true);
    expect(engine.createLoginGrantStore(stateRoot).list()).toMatchObject([
      {
        profileId: "profile_1",
        origin: "https://accounts.example.com",
        itemId: "item_home",
        itemTitle: "Example — home",
        vault: "Private",
        fields: [{ kind: "username" }, { kind: "password" }, { kind: "otp" }],
      },
    ]);
  });

  test("a vault that cannot answer reaches the window as the visible error, and nothing is confirmable", async () => {
    const { stateRoot, offer, window, trusted, invoke } = harness({
      listCandidates: async () => ({ ok: false, error: "1Password is locked." }),
    });
    offer.entryFinished(capture());
    const win = window();
    const shown = await invoke("telar:login-offer:state", trusted(win));
    expect(shown).toMatchObject({ error: "1Password is locked.", candidates: [] });
    expect((await invoke("telar:login-offer:confirm", trusted(win), { itemId: "item_work" })).ok).toBe(false);
    expect(engine.createLoginGrantStore(stateRoot).list()).toEqual([]);
    win.close();
  });

  test("dismissing through the installed handler closes and silences the automatic offer; the explicit one still opens", async () => {
    const { offer, window, trusted, invoke } = harness();
    const first = capture();
    offer.entryFinished(first);
    const win = window();
    await invoke("telar:login-offer:dismiss", trusted(win));
    expect(win.destroyed).toBe(true);
    const count = FakeBrowserWindow.instances.length;
    offer.entryFinished(capture({ tabUid: "tab_9" })); // same identity+address
    expect(FakeBrowserWindow.instances.length).toBe(count); // stayed quiet
    expect(offer.explicitOffer(capture())).toEqual({ ok: true });
    expect(FakeBrowserWindow.instances.length).toBe(count + 1);
    window().close();
  });

  test("the person closing the window counts as a dismissal", () => {
    const { offer, window } = harness();
    offer.entryFinished(capture());
    window().close(); // the person, not the flow
    const count = FakeBrowserWindow.instances.length;
    offer.entryFinished(capture({ tabUid: "tab_9" }));
    expect(FakeBrowserWindow.instances.length).toBe(count);
  });

  test("a second offer while one is open reuses the window and tells it to refresh", async () => {
    const { offer, window, trusted, invoke } = harness();
    offer.entryFinished(capture());
    const win = window();
    offer.entryFinished(capture({ origin: "https://other.example.net/x", tabUid: "tab_2" }));
    expect(window()).toBe(win); // no second window
    expect(win.webContents.sent).toContainEqual({ channel: "telar:login-offer:refresh", payload: undefined });
    expect((await invoke("telar:login-offer:state", trusted(win))).origin).toBe("https://other.example.net");
    win.close();
  });
});
