const { describe, expect, test } = require("bun:test");
const { mainSource } = require("../../test/main-source");

const main = mainSource();

const handlers = main.slice(
  main.indexOf('ipcMain.handle("telar:browser:suggestions"'),
  main.indexOf('ipcMain.on("telar:browser:login-entry"'),
);

describe("a panel request is answered by its own window's host", () => {
  test("this test is reading the handlers", () => {
    expect(handlers.length).toBeGreaterThan(0);

    expect(handlers).toContain('ipcMain.on("telar:browser:set-bounds"');
  });

  test("not one of them resolves the host without a sender", () => {
    // global is whichever window was created last.
    expect(handlers).not.toContain("requireBrowserManager()");
    expect(handlers.match(/requireBrowserManager\(event\)/g).length).toBeGreaterThan(20);
  });

  test("and none of them names the module-level variable directly", () => {
    expect(handlers).not.toMatch(/\bbrowserManager\b(?!s)/);
  });

  test("the resolver matches the sender against a window's OWN renderer", () => {
    expect(main).toContain("function managerForEvent(event) {");
    expect(main).toContain("manager.window.webContents === sender");
    expect(main).toContain("!manager.window.isDestroyed()");
  });
});

describe("the registry follows the windows", () => {
  test("a new window's host joins it, and a closed window's leaves", () => {
    expect(main).toContain("browserManagers.add(manager);");
    expect(main).toContain("browserManagers.delete(manager);");
  });

  test("closing the focused window falls back to another live host rather than to null", () => {
    expect(main).toContain("if (browserManager === manager) browserManager = browserManagers.values().next().value ?? null;");
  });

  test("the fallback follows focus, so the callers without a sender mean the window in use", () => {
    const created = main.slice(main.indexOf("browserManagers.add(manager);"), main.indexOf('win.on("closed"'));
    expect(created).toContain('win.on("focus"');
  });

  test("a tab's own report is offered to every host, since a tab resolves to no window", () => {
    const loginEntry = main.slice(
      main.indexOf('ipcMain.on("telar:browser:login-entry"'),
      main.indexOf("module.exports", main.indexOf('ipcMain.on("telar:browser:login-entry"')),
    );
    expect(loginEntry).toContain("for (const manager of browserManagers) manager.noteLoginEntryFromWebContents(event.sender");
    expect(loginEntry).toContain("for (const manager of browserManagers) manager.noteHumanInputFromWebContents(event.sender);");
    expect(loginEntry).not.toMatch(/\bbrowserManager\b(?!s)/);
  });

  test("the agent's control server resolves the host by scope, never from the bare global", () => {
    const wiring = main.slice(main.indexOf("startBrowserControlServer({"), main.indexOf("let url = OVERRIDE_URL;"));
    expect(wiring).toContain("getBrowserManager: (scopeKey) => managerForScope(browserManagers, scopeKey, browserManager)");
    expect(wiring).not.toContain("getBrowserManager: () =>");
  });

  test("quitting writes every window's tab inventory, not just the focused one's", () => {
    const quit = main.slice(main.indexOf('app.on("will-quit"'), main.indexOf("ipcMain.handle(\"telar:app:relaunch\""));
    expect(quit).toContain("for (const manager of browserManagers) { try { manager.persistSync(); } catch {} }");
  });
});
