/**
 * THE OAUTH POPUP, END TO END, IN A REAL ELECTRON (#615).
 *
 * Signing into Cloudflare with Google used to open the Google flow as an
 * ordinary Telar tab and then stop: the callback never reached the page that
 * started it, and the leftover tab sat on the callback URL. The cause was that
 * the tab was OURS — `setWindowOpenHandler` denied Chromium's popup and we
 * re-opened the URL — so there was no opener relationship, and that
 * relationship is the entire mechanism a popup sign-in hands its result back
 * through.
 *
 * A test that asserts what the handler RETURNS cannot see any of that. The
 * postcondition is behavioural and is what this file drives, against two
 * static pages on 127.0.0.1 — no network, no Google, no live OAuth:
 *
 *   1. a page calls `window.open`, and the popup lands as a Telar TAB in the
 *      same session (no BrowserWindow appears);
 *   2. the popup's `window.opener` is live and its `postMessage` ARRIVES at
 *      the opener, which is the callback that used to vanish;
 *   3. the opener's `window.open()` handle is real, so `popup.closed` polling
 *      — the other way these flows read the result — has something to poll;
 *   4. `window.close()` from the popup closes the tab (the lingering tab), and
 *      the opener sees `handle.closed` flip;
 *   5. the popup is on the OPENER's partition, so the session cookie lands in
 *      the identity the person signed in under;
 *   6. attribution survives: an agent's popup is the agent's and does not move
 *      the human's view, and a human's hands in a popup tab are still read as
 *      a human's;
 *   7. the scheme fence still refuses: adoption is not a hole around
 *      `normalizePopupUrl`.
 *
 * Run: `bun run test:desktop:popup` (own temp userData, hidden window, nothing
 * shown and no focus taken). Prints BROWSER_POPUP_OK.
 */
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { removeUserData } = require("./electron-test-teardown");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-browser-popup-")));

/** The page that starts a sign-in: it opens a popup and waits to be told how
 *  it went, which is what every popup-based OAuth client does. */
const OPENER = `<!doctype html><html><head><meta charset="utf-8"><title>Opener</title></head>
<body style="font-family:system-ui;padding:32px">
  <h1>Opener</h1>
  <button id="signin" onclick="signIn()">Sign in</button>
  <p id="result">waiting</p>
  <script>
    window.__handle = "none";
    window.__callback = null;
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin) return;
      window.__callback = event.data;
      document.getElementById("result").textContent = "callback: " + JSON.stringify(event.data);
    });
    function signIn(target) {
      const handle = window.open(target || "/popup", "oauth", "width=520,height=640");
      window.__handle = handle === null ? "null" : "window";
      window.__popup = handle;
      return window.__handle;
    }
    function popupClosed() { try { return Boolean(window.__popup && window.__popup.closed); } catch (e) { return "throw"; } }
  </script>
</body></html>`;

/** The provider's callback page: hand the result to the opener and go away —
 *  the two things that both failed before. */
const POPUP = `<!doctype html><html><head><meta charset="utf-8"><title>Callback</title></head>
<body style="font-family:system-ui;padding:32px">
  <h1>Callback</h1>
  <button id="finish" onclick="finish()">Finish</button>
  <script>
    window.__opener = window.opener === null ? "null" : "window";
    window.__posted = "not tried";
    function finish() {
      try {
        window.opener.postMessage({ code: "abc123", state: "xyz" }, location.origin);
        window.__posted = "ok";
      } catch (error) { window.__posted = "throw: " + error.message; }
      return window.__posted;
    }
    // Post on load too: a real provider callback does not wait to be clicked.
    finish();
  </script>
</body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
/** `executeJavaScript` never settles once the contents are gone — which is
 *  exactly what `window.close()` does — so every evaluation is bounded. */
async function evaluate(wc, expression, { gesture = false } = {}) {
  if (!wc || wc.isDestroyed()) return "DESTROYED";
  try {
    return await Promise.race([
      wc.executeJavaScript(expression, gesture),
      sleep(4000).then(() => "TIMEOUT"),
    ]);
  } catch (error) {
    return `THREW ${error.message}`;
  }
}
async function until(check, message, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url.startsWith("/popup") ? POPUP : OPENER);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => console.log(`POPUP ${line}`);

  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  const manager = new DesktopBrowserManager(window);
  // The same wiring main.js has: a tab preload heard a human's hands.
  ipcMain.on("telar:browser:human-input", (event) => {
    try { manager.noteHumanInputFromWebContents(event.sender); } catch {}
  });
  manager.declareProfile("popup", "none");
  const scope = "popup";
  const tabsOf = () => manager.state(scope).tabs;
  const contentsAt = (index) => manager.scopeTabs(scope)[index]?.view?.webContents || null;

  try {
    // ── 1. the popup is a TAB, not a window ──────────────────────────────
    // Opened DIRECTLY rather than through `callTool`, which would record agent
    // input on the scope and put the popup below inside the attribution grace.
    await manager.createTab(scope, `${base}/`, "human");
    const opener = manager.scopeTabs(scope)[0];
    await until(async () => (await evaluate(opener.view.webContents, "document.readyState")) === "complete", "opener never loaded");
    const windowsBefore = BrowserWindow.getAllWindows().length;

    // A human's own gesture: the popup is theirs, and their view follows it.
    assert((await evaluate(opener.view.webContents, "signIn()", { gesture: true })) === "window",
      "window.open() returned null to the opener — there is nothing to poll");
    await manager.settlePopupTabs();
    await until(async () => manager.scopeTabs(scope).length === 2, "the popup never became a tab");

    assert(BrowserWindow.getAllWindows().length === windowsBefore,
      `the popup opened a separate window (${BrowserWindow.getAllWindows().length} vs ${windowsBefore})`);
    const popup = manager.scopeTabs(scope)[1];
    // The first navigation is Chromium's, not a `loadTab` the manager awaits
    // — see settlePopupTabs — so the URL is waited for, not assumed.
    await until(() => popup.url.startsWith(`${base}/popup`), `the popup tab stayed at ${popup.url}`);
    note(`tabs after window.open: ${JSON.stringify(tabsOf().map((t) => [t.url, t.active, t.openedBy]))}`);
    assert(tabsOf()[1].openedBy === "human" && tabsOf()[1].active,
      "a human's own popup should be theirs and in front of them");

    // ── 2 + 3. the opener relationship, which is the whole bug ───────────
    await until(async () => (await evaluate(popup.view.webContents, "document.readyState")) === "complete", "popup never loaded");
    const seenOpener = await evaluate(popup.view.webContents, "window.__opener");
    note(`popup window.opener = ${seenOpener}`);
    assert(seenOpener === "window", "window.opener is null in the popup — the callback cannot be handed back");

    await until(async () => Boolean(await evaluate(opener.view.webContents, "window.__callback")),
      "the opener never received the popup's postMessage");
    const callback = await evaluate(opener.view.webContents, "window.__callback");
    note(`opener received ${JSON.stringify(callback)}`);
    assert(callback && callback.code === "abc123" && callback.state === "xyz",
      `the callback arrived mangled: ${JSON.stringify(callback)}`);
    assert((await evaluate(popup.view.webContents, "window.__posted")) === "ok",
      "the popup's postMessage threw");
    assert((await evaluate(opener.view.webContents, "popupClosed()")) === false,
      "the opener cannot see its own popup as open");

    // ── 5. the identity the cookie would land in ─────────────────────────
    note(`partitions: opener=${opener.partition} popup=${popup.partition}`);
    assert(popup.partition === opener.partition && popup.profileId === opener.profileId,
      "the popup tab is filed under a different profile than its opener");
    assert(popup.view.webContents.session === session.fromPartition(opener.partition),
      "the popup's WebContents is on a different Chromium session than its opener");

    // ── 6. a human's hands in the popup are still a human's ──────────────
    // (The popup inherits the opener's preload, which is how a click in the
    //  page becomes a control-model takeover — it is not ours to set on an
    //  adopted WebContents, so it is checked rather than assumed.)
    popup.view.webContents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    popup.view.webContents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
    await until(async () => tabsOf()[1].controller === "human", "a human's click in the popup was not attributed to them");
    note(`popup controller after a native click: ${tabsOf()[1].controller}`);

    // ── 4. window.close(), the other half of the flow ────────────────────
    const closing = evaluate(popup.view.webContents, "window.close()");
    await until(async () => manager.scopeTabs(scope).length === 1, "window.close() did not close the popup tab");
    await closing;
    note(`tabs after window.close(): ${JSON.stringify(tabsOf().map((t) => t.url))}`);
    await until(async () => (await evaluate(opener.view.webContents, "popupClosed()")) === true,
      "the opener never saw its popup close");
    // The dead view is not left parented to the window.
    assert(!window.contentView.children.includes(popup.view),
      "the closed popup's view is still a child of the window");

    // ── 7. the scheme fence still refuses ────────────────────────────────
    for (const target of ["chrome://settings", "file:///etc/passwd"]) {
      const answer = await evaluate(opener.view.webContents, `signIn(${JSON.stringify(target)})`, { gesture: true });
      await manager.settlePopupTabs();
      await sleep(200);
      note(`refused target ${target}: handle=${answer} tabs=${manager.scopeTabs(scope).length}`);
      assert(manager.scopeTabs(scope).length === 1, `${target} opened a tab`);
    }

    // ── 6b. an AGENT's popup does not take the human's screen ────────────
    const humanTabBefore = manager.state(scope).tabs.findIndex((tab) => tab.active);
    opener.agentBusy = 1;
    assert((await evaluate(opener.view.webContents, "signIn()", { gesture: true })) === "window", "the agent's window.open returned null");
    await manager.settlePopupTabs();
    await until(async () => manager.scopeTabs(scope).length === 2, "the agent's popup never became a tab");
    opener.agentBusy = 0;
    const after = tabsOf();
    note(`agent popup: ${JSON.stringify(after.map((t) => [t.openedBy, t.active, t.agentFocus]))}`);
    assert(after[1].openedBy === "agent", "an agent's popup was attributed to the human");
    assert(after[1].agentFocus, "an agent's popup did not become the agent's tab");
    assert(after.findIndex((tab) => tab.active) === humanTabBefore,
      "an agent's popup moved the human's view");
    // ...and the opener relationship is no weaker for an agent's popup.
    const agentPopup = manager.scopeTabs(scope)[1];
    await until(async () => (await evaluate(agentPopup.view.webContents, "window.__opener")) === "window",
      "an agent-attributed popup lost its opener");

    console.log("BROWSER_POPUP_OK");
  } finally {
    try { manager.releaseScope(scope, true); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await removeUserData(app.getPath("userData"));
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_POPUP_FAIL", error);
    app.exit(1);
  },
);
