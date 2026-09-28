const { afterEach, describe, expect, test } = require("bun:test");
const { eventFrom, FakeBrowserWindow, FakeWebContents, resetElectron } = require("../../test/fake-electron");
const hosts = require("./browser-hosts");

const added = [];
function host(name) {
  const win = new FakeBrowserWindow();
  const manager = { name, window: win, persisted: 0, persistSync() { this.persisted += 1; } };
  hosts.addHost(win, manager);
  added.push(manager);
  return { win, manager };
}

afterEach(() => {
  for (const manager of added.splice(0)) hosts.removeHost(manager);
  resetElectron();
});

describe("a request is answered by its own window's host", () => {
  test("the sender's window wins over whichever window came last", () => {
    const a = host("a");
    host("b");
    expect(hosts.requireBrowserManager(eventFrom(a.win))).toBe(a.manager);
  });

  test("a sender that is no window's renderer falls back to the window in use", () => {
    host("a");
    const b = host("b");
    expect(hosts.requireBrowserManager({ sender: new FakeWebContents() })).toBe(b.manager);
  });

  test("with no window there is no host, and it says so", () => {
    expect(() => hosts.requireBrowserManager({ sender: new FakeWebContents() })).toThrow("not ready");
  });

  test("a destroyed window's renderer resolves to nothing of its own", () => {
    const a = host("a");
    const b = host("b");
    a.win.destroyed = true;
    expect(hosts.requireBrowserManager(eventFrom(a.win))).toBe(b.manager);
  });
});

describe("only the cockpit's own top frame passes the cockpit check", () => {
  test("the window's main frame passes, and gets its host back", () => {
    const a = host("a");
    expect(hosts.requireCockpitSender(eventFrom(a.win), "do it")).toBe(a.manager);
  });

  test("a subframe, a tab or another renderer is refused by name", () => {
    const a = host("a");
    expect(() => hosts.requireCockpitSender(eventFrom(a.win, { frame: { name: "sub" } }), "do it")).toThrow("Only the Telar window may do it.");
    expect(() => hosts.requireCockpitSender(eventFrom(a.win, { sender: new FakeWebContents() }), "do it")).toThrow("Only the Telar window may do it.");
  });
});

describe("the registry follows the windows", () => {
  test("focus makes a window the one in use", () => {
    const a = host("a");
    host("b");
    a.win.focus();
    expect(hosts.currentHost()).toBe(a.manager);
  });

  test("removing the window in use falls back to another live host rather than to null", () => {
    const a = host("a");
    const b = host("b");
    hosts.removeHost(b.manager);
    expect(hosts.currentHost()).toBe(a.manager);
    hosts.removeHost(a.manager);
    expect(hosts.currentHost()).toBeNull();
  });

  test("quitting writes every window's tab inventory, and one failure stops none of the others", () => {
    const a = host("a");
    const b = host("b");
    a.manager.persistSync = () => { throw new Error("disk full"); };
    hosts.persistAllHosts();
    expect(b.manager.persisted).toBe(1);
  });
});
