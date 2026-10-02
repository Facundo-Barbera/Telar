const { afterAll, beforeAll, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { electron, eventFrom, FakeBrowserWindow, FakeWebContents, resetElectron, userData } = require("../../test/fake-electron");
const hosts = require("./browser-hosts");
const { registerBrowserIpc } = require("./ipc-browser");

function fakeManager(win, name) {
  return {
    name,
    window: win,
    calls: [],
    state(scopeKey) { this.calls.push(["state", scopeKey]); return { name }; },
    setBounds(scopeKey) { this.calls.push(["setBounds", scopeKey]); },
    noteLoginEntryFromWebContents(sender) { this.calls.push(["loginEntry", sender]); },
    noteHumanInputFromWebContents(sender) { this.calls.push(["humanInput", sender]); },
  };
}

let a;
let b;
beforeAll(() => {
  resetElectron();
  registerBrowserIpc({ requireBrowserSuggestions: () => ({}), requireLoginOffer: () => ({}) });
  const winA = new FakeBrowserWindow();
  const winB = new FakeBrowserWindow();
  a = fakeManager(winA, "a");
  b = fakeManager(winB, "b");
  hosts.addHost(winA, a);
  hosts.addHost(winB, b);
});

afterAll(() => {
  hosts.removeHost(a);
  hosts.removeHost(b);
  resetElectron();
});

describe("a panel request is answered by its own window's host", () => {
  test("an invoke from the older window reaches that window's host, not the newest", async () => {
    expect(await electron.ipcMain.invoke("telar:browser:state", eventFrom(a.window), "s1")).toEqual({ name: "a" });
    expect(b.calls).toEqual([]);
  });

  test("so does a fire-and-forget send", () => {
    electron.ipcMain.send("telar:browser:set-bounds", eventFrom(a.window), { scopeKey: "s1", bounds: {} });
    expect(a.calls).toContainEqual(["setBounds", "s1"]);
  });

  test("a tab's own report is offered to every host, since a tab resolves to no window", () => {
    const tab = new FakeWebContents();
    electron.ipcMain.send("telar:browser:login-entry", { sender: tab }, {});
    electron.ipcMain.send("telar:browser:human-input", { sender: tab });
    for (const manager of [a, b]) {
      expect(manager.calls).toContainEqual(["loginEntry", tab]);
      expect(manager.calls).toContainEqual(["humanInput", tab]);
    }
  });
});

describe("the open-external handler", () => {
  test("the cockpit's top frame opens an http(s) page, and the OS gets the parsed href", async () => {
    const result = await electron.ipcMain.invoke("telar:browser:open-external", eventFrom(a.window), { url: "HTTPS://Example.COM/Path" });
    expect(result).toEqual({ ok: true });
    expect(electron.shell.opened).toEqual(["https://example.com/Path"]);
  });

  test("any other scheme is refused before anything reaches the OS", async () => {
    electron.shell.opened = [];
    const result = await electron.ipcMain.invoke("telar:browser:open-external", eventFrom(a.window), { url: "file:///etc/passwd" });
    expect(result.ok).toBe(false);
    expect(electron.shell.opened).toEqual([]);
  });

  test("a subframe or another renderer may not ask at all", () => {
    electron.shell.opened = [];
    const subframe = eventFrom(a.window, { frame: { name: "sub" } });
    expect(() => electron.ipcMain.invoke("telar:browser:open-external", subframe, { url: "https://example.com/" })).toThrow("Only the Telar window");
    expect(electron.shell.opened).toEqual([]);
  });
});

describe("the password manager app", () => {
  test("the cockpit can open it, to authorize this browser", async () => {
    electron.shell.opened = [];
    expect(await electron.ipcMain.invoke("telar:browser:open-password-manager", eventFrom(a.window))).toEqual({ ok: true });
    expect(electron.shell.opened).toEqual(["/Applications/1Password.app"]);
  });

  test("a missing app is reported, not thrown", async () => {
    electron.shell.openPathError = "not found";
    const result = await electron.ipcMain.invoke("telar:browser:open-password-manager", eventFrom(a.window));
    electron.shell.openPathError = undefined;
    expect(result.ok).toBe(false);
  });
});

describe("the login offer setting", () => {
  test("is off until the cockpit turns it on, and stays on", async () => {
    fs.rmSync(path.join(userData, "login-offer-prefs.json"), { force: true });
    expect(await electron.ipcMain.invoke("telar:login-offer:prefs", eventFrom(a.window), {})).toEqual({ offerAfterSignIn: false });
    await electron.ipcMain.invoke("telar:login-offer:prefs", eventFrom(a.window), { offerAfterSignIn: true });
    expect(await electron.ipcMain.invoke("telar:login-offer:prefs", eventFrom(a.window), {})).toEqual({ offerAfterSignIn: true });
    fs.rmSync(path.join(userData, "login-offer-prefs.json"), { force: true });
  });
});
