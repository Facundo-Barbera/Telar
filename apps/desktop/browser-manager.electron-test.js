/**
 * THE BACKGROUND-BROWSER REGRESSION, in a real Electron.
 *
 * The desktop host used to be drivable only while the cockpit's browser
 * panel was mounted: until `setBounds` arrived, every view sat hidden at the
 * 1×1 default, synthetic clicks fell outside the visual viewport and were
 * dropped, and `Page.captureScreenshot` hung. An agent browsing while the
 * panel is closed — or from a web client that has no panel — is the intended
 * case, so this proves it against a real `WebContentsView`, not a fake:
 *
 *   1. hidden, unmounted view: a fixture button click increments, a note
 *      saved to localStorage survives navigate-away / back / reload;
 *   2. a screenshot of that hidden view is a non-empty PNG with the emulated
 *      1280×800 dimensions;
 *   3. mounting real bounds clears the emulation: the page measures the
 *      panel's width and the screenshot follows — and a second scope, a
 *      panel put away, and a tab re-woken from hibernation all get it back.
 *
 * Run: `bun run test:desktop:browser` (spawns Electron with its own temp
 * userData and a hidden window; nothing is shown and no focus is taken).
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { removeUserData } = require("./electron-test-teardown");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-browser-regression-")));

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Telar browser regression</title></head>
<body style="font-family:system-ui;padding:32px">
  <h1>Regression fixture</h1>
  <label>Note <input id="note" aria-label="Note"></label>
  <button id="save" onclick="localStorage.setItem('note', document.getElementById('note').value); render()">Save note</button>
  <p id="saved"></p>
  <button id="counter" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Increment counter</button>
  <p>Count: <span id="count">0</span></p>
  <a id="second" href="/second">Second page</a>
  <div style="height:2200px;background:linear-gradient(#08f,#0f8)"></div>
  <script>function render(){ document.getElementById('saved').textContent = 'Saved note: ' + (localStorage.getItem('note') || '(none)'); } render();</script>
</body></html>`;
const SECOND = `<!doctype html><html><head><title>Second</title></head><body><h1>Second page</h1><a href="/">Home</a></body></html>`;

function textOf(result) {
  return (result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function pngSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  assert(bytes.length > 24 && bytes.toString("ascii", 1, 4) === "PNG", "screenshot is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
async function evaluate(manager, tab, expression) {
  const debug = await manager.ensureDebugger(tab);
  const result = await debug.sendCommand("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value;
}
async function settle(manager, tab) {
  // Navigation completion: wait until the debugger can see the document.
  for (let i = 0; i < 50; i += 1) {
    if (!tab.loading && (await evaluate(manager, tab, "document.readyState")) === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("page did not settle");
}
async function until(manager, tab, expression, expected) {
  for (let i = 0; i < 30 && (await evaluate(manager, tab, expression)) !== expected; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function ref(snapshotText, label) {
  const match = snapshotText.match(new RegExp(`${label}[^\\n]*\\[ref=(e\\d+)\\]`));
  assert(match, `no ref for ${label} in:\n${snapshotText}`);
  return match[1];
}

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url === "/second" ? SECOND : FIXTURE);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => {

    console.log(`REGRESSION ${line}`);
  };

  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  const manager = new DesktopBrowserManager(window);
  // The same wiring main.js has: a tab preload heard a human's hands.
  ipcMain.on("telar:browser:human-input", (event) => {
    try { manager.noteHumanInputFromWebContents(event.sender); } catch {}
  });
  // Per-project profiles fail closed: a scope must declare one before a tab.
  manager.declareProfile("regression", "none");
  manager.declareProfile("other", "none");
  const scope = "regression";
  try {
    // ── 1. hidden + unmounted (bounds still the 1×1 default) ────────────
    await manager.callTool(scope, "browser_tabs", { action: "new", url: `${base}/` });
    const tab = manager.activeTab(scope);
    await settle(manager, tab);
    assert(manager.bounds.width === 1 && manager.bounds.height === 1, "bounds should still be the 1×1 default");
    assert(!window.isVisible(), "the window must stay hidden");
    const inner = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`unmounted viewport innerWidth×innerHeight = ${inner[0]}×${inner[1]}`);
    assert(inner[0] === 1280 && inner[1] === 800, "emulated viewport not applied while unmounted");

    let snap = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    const counterRef = ref(snap, 'button "Increment counter"');
    const t0 = Date.now();
    const clicked = await manager.callTool(scope, "browser_click", { target: counterRef });
    note(`click tool answered in ${Date.now() - t0}ms: ${textOf(clicked)}`);
    assert(!clicked.isError, `click errored: ${textOf(clicked)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const count = await evaluate(manager, tab, "document.getElementById('count').textContent");
    note(`counter after hidden click = ${count}`);
    assert(count === "1", "hidden click did not increment the counter");

    snap = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    const typed = await manager.callTool(scope, "browser_type", { target: ref(snap, 'textbox "Note"'), text: "telar-browser-acceptance" });
    assert(!typed.isError, textOf(typed));
    const saved = await manager.callTool(scope, "browser_click", { target: ref(snap, 'button "Save note"') });
    assert(!saved.isError, textOf(saved));
    note(`saved text = ${await evaluate(manager, tab, "document.getElementById('saved').textContent")}`);
    assert((await evaluate(manager, tab, "localStorage.getItem('note')")) === "telar-browser-acceptance", "note not saved");

    await manager.callTool(scope, "browser_navigate", { url: `${base}/second` });
    await settle(manager, tab);
    assert((await evaluate(manager, tab, "document.title")) === "Second", "did not reach the second page");
    await manager.callTool(scope, "browser_navigate_back", {});
    await settle(manager, tab);
    await manager.performAction(scope, { action: "reload" });
    await settle(manager, tab);
    const persisted = await evaluate(manager, tab, "document.getElementById('saved').textContent");
    note(`after navigate/back/reload: ${persisted}`);
    assert(persisted === "Saved note: telar-browser-acceptance", "note did not survive navigation + reload");

    // ── 2. screenshot of the hidden view ────────────────────────────────
    const started = Date.now();
    const shot = await manager.callTool(scope, "browser_take_screenshot", {});
    const elapsed = Date.now() - started;
    assert(!shot.isError, `hidden screenshot errored: ${textOf(shot)}`);
    const hiddenSize = pngSize(shot.content[0].data);
    note(`hidden screenshot ${hiddenSize.width}×${hiddenSize.height}, ${hiddenSize.bytes} bytes, ${elapsed}ms`);
    assert(hiddenSize.width >= 1280 && hiddenSize.height >= 800, "hidden screenshot is not the emulated viewport");
    assert(hiddenSize.bytes > 2_000, "hidden screenshot is suspiciously small (blank?)");

    // ── 3. mount real bounds. Fit is the default, so opt this tab into a
    //    FIXED size first: then the page KEEPS its intrinsic viewport and
    //    the panel only scales the presentation to fit. ──
    await manager.resizeTab(tab, { preset: "default" });
    manager.setBounds(scope, { x: 0, y: 0, width: 640, height: 480 });
    await manager.setVisible(scope, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mounted = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`mounted viewport innerWidth×innerHeight = ${mounted[0]}×${mounted[1]} (panel 640×480, scale ${manager.state(scope).presentation.scale})`);
    assert(mounted[0] === 1280 && mounted[1] === 800, "mounting the panel reflowed the page — the intrinsic viewport was lost");
    assert(manager.state(scope).presentation.scale === 0.5, "the presentation did not scale to fit the panel");
    assert(!window.isVisible(), "mounting bounds must not show the window");
    // The window is never shown, so the visible capture path has no
    // compositor frame here; the shown-inactive case is proven by
    // browser-persistence.electron-test.js. This run only checks it bounds.
    const shownShot = await manager.callTool(scope, "browser_take_screenshot", {});
    note(`mounted (never-shown window) screenshot: ${shownShot.isError ? textOf(shownShot).slice(0, 60) : `${pngSize(shownShot.content[0].data).width}px`}`);

    // Resize the panel while mounted: still no reflow; the scale follows.
    manager.setBounds(scope, { x: 0, y: 0, width: 900, height: 500 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    note(`panel 900×500 → innerWidth = ${await evaluate(manager, tab, "innerWidth")}, scale ${manager.state(scope).presentation.scale}`);
    assert((await evaluate(manager, tab, "innerWidth")) === 1280, "a panel resize reflowed the page");

    // A SECOND scope while the first is mounted: its tab is not the shown
    // one, so it must still get the emulated viewport and a working click.
    await manager.callTool("other", "browser_tabs", { action: "new", url: `${base}/` });
    const otherTab = manager.activeTab("other");
    await settle(manager, otherTab);
    note(`inactive scope innerWidth = ${await evaluate(manager, otherTab, "innerWidth")}`);
    assert((await evaluate(manager, otherTab, "innerWidth")) === 1280, "inactive scope did not get the emulated viewport");
    const otherSnap = textOf(await manager.callTool("other", "browser_snapshot", {}));
    await manager.callTool("other", "browser_click", { target: ref(otherSnap, 'button "Increment counter"') });
    assert((await evaluate(manager, otherTab, "document.getElementById('count').textContent")) === "1", "inactive-scope click dropped");
    const otherShot = pngSize((await manager.callTool("other", "browser_take_screenshot", {})).content[0].data);
    note(`inactive scope screenshot ${otherShot.width}×${otherShot.height}`);
    assert(otherShot.width >= 1280, "inactive-scope screenshot is not the emulated viewport");
    // Full-page on the hidden path is honoured, not downgraded.
    const tall = pngSize((await manager.callTool("other", "browser_take_screenshot", { fullPage: true })).content[0].data);
    note(`inactive scope fullPage screenshot ${tall.width}×${tall.height}`);
    assert(tall.height > 2000, `fullPage capture (${tall.height}px) is not the document's height`);
    const restored = await evaluate(manager, otherTab, "[innerWidth, innerHeight]");
    note(`viewport after fullPage = ${restored[0]}×${restored[1]}`);
    assert(restored[0] === 1280 && restored[1] === 800, "fullPage capture did not restore the emulated viewport");
    const afterTall = pngSize((await manager.callTool("other", "browser_take_screenshot", {})).content[0].data);
    assert(afterTall.height === 800, `viewport capture after fullPage is ${afterTall.height}px tall`);

    // Hide after mount (panel closed): `setVisible(false)` is what the
    // cockpit sends when the browser tab is put away (hideVisibleScope is
    // the renderer-reload path and reclaims the view on purpose).
    await manager.setVisible(scope, false);
    assert(tab.view, "putting the panel away must not tear the view down");
    await until(manager, tab, "innerWidth", 1280);
    note(`hidden-after-mount innerWidth = ${await evaluate(manager, tab, "innerWidth")}`);
    const hiddenAgain = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    await manager.callTool(scope, "browser_click", { target: ref(hiddenAgain, 'button "Increment counter"') });
    assert((await evaluate(manager, tab, "document.getElementById('count').textContent")) === "1", "click after hide dropped");

    // Re-wake: a hibernated tab gets a NEW WebContents; the override must be
    // re-applied to it, not assumed from the old one.
    manager.hibernateTab(tab);
    assert(!tab.view, "tab did not hibernate");
    // The snapshot is what wakes it (a new WebContents); only then is there
    // a debugger to ask anything of.
    const wakeSnap = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    assert(tab.view, "snapshot did not wake the tab");
    await settle(manager, tab);
    note(`re-woken innerWidth = ${await evaluate(manager, tab, "innerWidth")}`);
    assert((await evaluate(manager, tab, "innerWidth")) === 1280, "re-woken tab lost the emulated viewport");
    // The wake RELOADED the page under that snapshot (did-navigate after the
    // read started), so a click decided from it is refused as stale — by
    // design. Look once more at the settled page, then act.
    const staleAfterWake = await manager.callTool(scope, "browser_click", { target: ref(wakeSnap, 'button "Increment counter"') });
    note(`click from the wake snapshot: ${staleAfterWake.isError ? textOf(staleAfterWake).slice(0, 70) : "allowed"}`);
    assert(staleAfterWake.isError, "a click decided from a snapshot the wake reload invalidated was allowed");
    const wokenSnap = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    await manager.callTool(scope, "browser_click", { target: ref(wokenSnap, 'button "Increment counter"') });
    assert((await evaluate(manager, tab, "document.getElementById('count').textContent")) === "1", "click after re-wake dropped");
    assert((await evaluate(manager, tab, "document.getElementById('saved').textContent")) === "Saved note: telar-browser-acceptance", "note lost across re-wake");

    // ── 4. SHARED BROWSER: synthetic vs human input, in a real WebContents ──
    // (a) The agent's own click raises pointerdown in the page; the tab
    //     preload reports it; it must NOT read as a human interrupting.
    manager.releaseScope("other", true);
    await manager.callTool(scope, "browser_navigate", { url: `${base}/` });
    await settle(manager, tab);
    let snapNow = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    const before = manager.state(scope).tabs[0].controller;
    const synthetic = await manager.callTool(scope, "browser_click", { target: ref(snapNow, 'button "Increment counter"') });
    assert(!synthetic.isError, `agent click misattributed: ${textOf(synthetic)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    note(`after agent click: controller before=${before} after=${manager.state(scope).tabs[0].controller}`);
    assert(manager.state(scope).tabs[0].controller !== "human", "the agent's synthetic click was taken for a human");
    // A second agent click right after is still fresh (no generation bump).
    const again = await manager.callTool(scope, "browser_click", { target: ref(snapNow, 'button "Increment counter"') });
    assert(!again.isError, `second agent click refused: ${textOf(again)}`);

    // (b) A HUMAN's hands: dispatched through the webContents' own input path
    //     (not CDP, not a tool call) while no agent call is in flight.
    await new Promise((resolve) => setTimeout(resolve, 600));
    tab.view.webContents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
    for (let i = 0; i < 20 && manager.state(scope).tabs[0].controller !== "human"; i += 1) await new Promise((r) => setTimeout(r, 50));
    note(`after native human click: controller=${manager.state(scope).tabs[0].controller}`);
    assert(manager.state(scope).tabs[0].controller === "human", "a native human click was not attributed to the human");
    // The agent's next click, decided from the old snapshot, is STALE.
    const stale = await manager.callTool(scope, "browser_click", { target: ref(snapNow, 'button "Increment counter"') });
    note(`agent click after human input: ${textOf(stale).slice(0, 90)}`);
    assert(stale.isError && /changed since you last looked|interacting with tab/.test(textOf(stale)), "stale action was not refused");
    // Look again, then it goes.
    snapNow = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    const resumed = await manager.callTool(scope, "browser_click", { target: ref(snapNow, 'button "Increment counter"') });
    assert(!resumed.isError, `click after re-observe refused: ${textOf(resumed)}`);

    // (c) A human cuts in DURING slow typing: the type stops between chars.
    snapNow = textOf(await manager.callTool(scope, "browser_snapshot", {}));
    const noteRef = ref(snapNow, 'textbox "Note"');
    const typing = manager.callTool(scope, "browser_type", { target: noteRef, text: "abcdefghijklmnopqrstuvwxyz0123456789", slowly: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    tab.view.webContents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
    const interrupted = await typing;
    const typedValue = await evaluate(manager, tab, "document.getElementById('note').value");
    note(`interrupted typing: error=${Boolean(interrupted.isError)} typed=${JSON.stringify(typedValue)} (${typedValue.length} chars)`);
    assert(interrupted.isError && /Stopped/.test(textOf(interrupted)), "typing was not stopped by human input mid-action");
    assert(typedValue.length < 36, "typing ran to completion despite human input");

    console.log("BROWSER_REGRESSION_OK");
  } finally {
    for (const key of [scope, "other"]) {
      try { manager.releaseScope(key, true); } catch {}
    }
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await removeUserData(app.getPath("userData"));
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_REGRESSION_FAIL", error);
    app.exit(1);
  },
);
