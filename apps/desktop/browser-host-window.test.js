// ONE BROWSER HOST PER WINDOW, PINNED BY SOURCE.
//
// `main.js` is not requirable — it calls `app.whenReady()` on its first lines
// and expects an Electron main process around it — so this holds the rule the
// way external-links.test.js and workspace-open.test.js hold theirs: by reading
// the file. What it is guarding is not a branch but an ABSENCE. A second window
// (telar:app:open-window) builds a second manager with its own native views,
// and the moment any panel handler reaches for the module-level `browserManager`
// instead of the sender's own, that handler starts moving one window's pages
// around inside another — silently, and only when two windows are open, which
// is exactly the bug a unit test has to catch before a human does.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

/** Every `ipcMain.handle` for the browser panel, as source. */
const handlers = main.slice(
  main.indexOf('ipcMain.handle("telar:browser:suggestions"'),
  main.indexOf('ipcMain.on("telar:browser:credential-field"'),
);

describe("a panel request is answered by its own window's host", () => {
  test("this test is reading the handlers", () => {
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers).toContain('ipcMain.handle("telar:browser:set-bounds"');
  });

  test("not one of them resolves the host without a sender", () => {
    // The whole rule, in one assertion: a bare call is the global, and the
    // global is whichever window was created last.
    expect(handlers).not.toContain("requireBrowserManager()");
    expect(handlers.match(/requireBrowserManager\(event\)/g).length).toBeGreaterThan(20);
  });

  test("and none of them names the module-level variable directly", () => {
    expect(handlers).not.toMatch(/\bbrowserManager\b(?!s)/);
  });

  test("the resolver matches the sender against a window's OWN renderer", () => {
    // A native tab view's webContents must not match a window: it would hand a
    // page's own preload the panel's authority over that window.
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
    const credential = main.slice(
      main.indexOf('ipcMain.on("telar:browser:credential-field"'),
      main.indexOf("let engineDiscovery"),
    );
    expect(credential).toContain("for (const manager of browserManagers) manager.noteCredentialFieldFromWebContents(event.sender");
    expect(credential).toContain("for (const manager of browserManagers) manager.noteHumanInputFromWebContents(event.sender);");
    expect(credential).not.toMatch(/\bbrowserManager\b(?!s)/);
  });

  test("the agent's control server resolves the host by scope, never from the bare global", () => {
    // Issue #311: an agent has no window to be recognised by, so the scope it
    // names is what picks the window. `getBrowserManager: () => browserManager`
    // is the bug — one global, whichever window the human last focused.
    const wiring = main.slice(main.indexOf("startBrowserControlServer({"), main.indexOf("let url = OVERRIDE_URL;"));
    expect(wiring).toContain("getBrowserManager: (scopeKey) => managerForScope(browserManagers, scopeKey, browserManager)");
    expect(wiring).not.toContain("getBrowserManager: () =>");
  });

  test("quitting writes every window's tab inventory, not just the focused one's", () => {
    const quit = main.slice(main.indexOf('app.on("will-quit"'), main.indexOf("ipcMain.handle(\"telar:app:relaunch\""));
    expect(quit).toContain("for (const manager of browserManagers) { try { manager.persistSync(); } catch {} }");
  });
});
