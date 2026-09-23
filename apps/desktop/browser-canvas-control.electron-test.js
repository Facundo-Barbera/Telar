/**
 * A PAGE DRAWN ON A CANVAS IS STILL DRIVABLE — in a real Electron.
 *
 * A spreadsheet drawn on a `<canvas>` has no accessibility refs for its
 * cells, so every ref-addressed tool is useless there. The agent acts by the
 * CSS pixels of its screenshot instead, types into whatever has focus, sends
 * chords, and pastes/copies through the page's own clipboard events.
 *
 * Measured here, through the manager's real tool surface (`callTool`):
 *   · a FIXED 1280×800 viewport shown at scale 0.5 in a 640×400 stage: a
 *     click, hover and drag by screenshot coordinates land at exactly those
 *     CSS pixels (the native point is css × scale — a mismatch lands at half
 *     or double);
 *   · a point outside the screenshot's viewport is refused;
 *   · FIT: the same holds with no scaling;
 *   · a click by coordinates focuses a textarea, and `browser_type` with no
 *     target types into it without clearing it, replacing a selection like a
 *     real insert; a chord reaches the page with its modifiers;
 *   · `browser_paste` hands the focused editable a real `paste` event, and
 *     `browser_copy` answers what the page's own `copy` handler wrote;
 *   · with nothing editable focused, typing without a target is refused.
 *
 * Run: `bun run test:desktop:canvas-control` from apps/desktop
 * (own temp userData, window shown inactive, no focus).
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { removeUserData } = require("./electron-test-teardown");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-canvas-control-")));

// Canvas under everything; the sink (a canvas spreadsheet's invisible input
// surface) and a plain textarea sit at known CSS positions above it.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Canvas control</title>
<style>
  body { margin:0; overflow:hidden; }
  #grid { position:absolute; left:0; top:0; width:1280px; height:800px; }
  #sink { position:absolute; left:20px; top:300px; width:120px; height:40px; opacity:0; outline:none; }
  #notes { position:absolute; left:300px; top:120px; width:200px; height:60px; margin:0; padding:0; border:0; }
</style></head><body>
<canvas id="grid" width="1280" height="800"></canvas>
<div id="sink" contenteditable="true"></div>
<textarea id="notes"></textarea>
<script>
  window.__hits = { click: null, move: null, down: null, up: null, pasted: null, keys: [] };
  const grid = document.getElementById('grid');
  const ctx = grid.getContext('2d');
  for (let x = 0; x < 1280; x += 80) ctx.strokeRect(x, 0, 80, 800);
  for (let y = 0; y < 800; y += 20) ctx.strokeRect(0, y, 1280, 20);
  grid.addEventListener('click', (e) => { __hits.click = [e.clientX, e.clientY]; });
  grid.addEventListener('mousemove', (e) => { __hits.move = [e.clientX, e.clientY]; });
  grid.addEventListener('mousedown', (e) => { __hits.down = [e.clientX, e.clientY]; });
  grid.addEventListener('mouseup', (e) => { __hits.up = [e.clientX, e.clientY]; });
  addEventListener('keydown', (e) => {
    __hits.keys.push({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  }, true);
  const sink = document.getElementById('sink');
  sink.addEventListener('paste', (e) => { __hits.pasted = e.clipboardData.getData('text/plain'); e.preventDefault(); });
  sink.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'a\\tb\\nc\\td'); e.preventDefault(); });
</script></body></html>`;

function assert(condition, message) { if (!condition) throw new Error(message); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
function textOf(result) { return (result.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n"); }
async function evaluate(manager, tab, expression) {
  // Read without ensureDebugger: verification must not repair geometry.
  return tab.view.webContents.executeJavaScript(expression);
}
async function settle(manager, tab) {
  for (let i = 0; i < 50; i += 1) {
    if (!tab.loading && (await evaluate(manager, tab, "document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("page did not settle");
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function untilHit(manager, tab, expression, expected) {
  let value;
  for (let i = 0; i < 30; i += 1) {
    value = await evaluate(manager, tab, expression);
    if (same(value, expected)) return value;
    await delay(50);
  }
  return value;
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => console.log(`CANVAS_CONTROL ${line}`);

  const window = new BrowserWindow({ show: false, width: 1200, height: 800 });
  window.showInactive();
  const manager = new DesktopBrowserManager(window);
  const scope = "s";
  const call = async (name, args) => {
    const result = await manager.callTool(scope, name, args);
    note(`${name} ${JSON.stringify(args)} → ${result.isError ? "ERROR " : ""}${textOf(result).slice(0, 160)}`);
    return result;
  };
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert(!result.isError, `${name} errored: ${textOf(result)}`);
    return result;
  };
  // The screenshot IS the observation coordinates are read from, and it
  // passes the stale-view gate for the mutations that follow.
  const observe = () => ok("browser_take_screenshot", {});
  try {
    manager.declareProfile(scope, "none");
    manager.setBounds(scope, { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible(scope, true);
    await ok("browser_tabs", { action: "new", url: `${base}/` });
    const tab = manager.activeTab(scope);
    await settle(manager, tab);

    // ── 1. FIXED 1280×800 shown at 0.5 in a 640×400 stage ──
    await ok("browser_resize", { preset: "default" });
    await tab.geometry.queue;
    const inner = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    const scale = manager.state(scope).presentation.scale;
    note(`fixed: inner=${inner} scale=${scale}`);
    assert(inner[0] === 1280 && inner[1] === 800, `fixed viewport not 1280×800 (${inner})`);
    assert(scale === 0.5, `fixed viewport not shown at 0.5 (${scale})`);

    await observe();
    const clicked = await ok("browser_click", { x: 300, y: 200 });
    assert(textOf(clicked).startsWith("Clicked at (300, 200)"), `click answer: ${textOf(clicked)}`);
    const click = await untilHit(manager, tab, "__hits.click", [300, 200]);
    assert(same(click, [300, 200]), `fixed click at (300,200) landed at ${click}`);

    await ok("browser_hover", { x: 50, y: 60 });
    const move = await untilHit(manager, tab, "__hits.move", [50, 60]);
    assert(same(move, [50, 60]), `fixed hover at (50,60) landed at ${move}`);

    await ok("browser_drag", { x: 600, y: 500, toX: 900, toY: 700 });
    const down = await untilHit(manager, tab, "__hits.down", [600, 500]);
    const up = await untilHit(manager, tab, "__hits.up", [900, 700]);
    assert(same(down, [600, 500]), `drag started at ${down}, expected 600,500`);
    assert(same(up, [900, 700]), `drag ended at ${up}, expected 900,700`);

    const outside = await call("browser_click", { x: 1400, y: 10 });
    assert(outside.isError && textOf(outside).includes("outside"), `a click outside the viewport was not refused: ${textOf(outside)}`);

    // ── 2. FIT: native, no scaling ──
    await ok("browser_resize", { mode: "fit" });
    await tab.geometry.queue;
    const fitInner = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`fit: inner=${fitInner} scale=${manager.state(scope).presentation.scale}`);
    assert(fitInner[0] === 640 && fitInner[1] === 400, `fit viewport is not the stage (${fitInner})`);
    await observe();
    await ok("browser_click", { x: 100, y: 50 });
    const fitClick = await untilHit(manager, tab, "__hits.click", [100, 50]);
    assert(same(fitClick, [100, 50]), `fit click at (100,50) landed at ${fitClick}`);

    // ── 3. click a field by coordinates, then type with NO target ──
    await observe();
    await ok("browser_click", { x: 400, y: 150 });
    const focused = await untilHit(manager, tab, "document.activeElement.id", "notes");
    assert(focused === "notes", `clicking the textarea by coordinates focused ${focused}`);
    await ok("browser_type", { text: "hello" });
    const typed = await untilHit(manager, tab, "document.getElementById('notes').value", "hello");
    assert(typed === "hello", `typing with no target gave ${JSON.stringify(typed)}`);
    await ok("browser_type", { text: " world" });
    const appended = await untilHit(manager, tab, "document.getElementById('notes').value", "hello world");
    assert(appended === "hello world", `typing again cleared the field: ${JSON.stringify(appended)}`);

    // A chord reaches the page with its modifier. Whether Meta+A then
    // selects all is the platform's key binding, not deterministic under a
    // background window, so the selection is made by the page instead.
    await ok("browser_press_key", { key: "Meta+A" });
    const keys = await evaluate(manager, tab, "__hits.keys");
    const chord = keys.find((k) => k.key.toLowerCase() === "a");
    assert(chord && chord.meta && !chord.ctrl && !chord.alt, `Meta+A reached the page as ${JSON.stringify(keys)}`);
    await evaluate(manager, tab, "document.getElementById('notes').select()");
    await ok("browser_type", { text: "x" });
    const replaced = await untilHit(manager, tab, "document.getElementById('notes').value", "x");
    assert(replaced === "x", `typing over a selection gave ${JSON.stringify(replaced)}`);

    // Paste where the page does NOT handle the event: inserted at the focus.
    await ok("browser_click", { x: 400, y: 150 });
    const inserted = await ok("browser_paste", { text: "zz" });
    assert(textOf(inserted).startsWith("Inserted 2 characters"), `unhandled paste answer: ${textOf(inserted)}`);
    const withPaste = await untilHit(manager, tab, "document.getElementById('notes').value.includes('zz')", true);
    assert(withPaste === true, "unhandled paste did not insert at the focused textarea");

    // ── 4. the canvas spreadsheet's sink: paste and copy through its events ──
    await observe();
    await ok("browser_click", { x: 80, y: 320 });
    const sinkFocused = await untilHit(manager, tab, "document.activeElement.id", "sink");
    assert(sinkFocused === "sink", `clicking the sink by coordinates focused ${sinkFocused}`);
    const pasted = await ok("browser_paste", { text: "1\t2\n3\t4" });
    assert(textOf(pasted).startsWith("Pasted 7 characters"), `handled paste answer: ${textOf(pasted)}`);
    const received = await untilHit(manager, tab, "__hits.pasted", "1\t2\n3\t4");
    assert(received === "1\t2\n3\t4", `the page's paste handler saw ${JSON.stringify(received)}`);
    const copied = await ok("browser_copy", {});
    assert(textOf(copied) === "a\tb\nc\td", `copy answered ${JSON.stringify(textOf(copied))}`);

    // ── 5. nothing editable focused: typing without a target is refused ──
    await evaluate(manager, tab, "document.activeElement && document.activeElement.blur()");
    const body = await untilHit(manager, tab, "document.activeElement === document.body", true);
    assert(body === true, "blur did not return focus to the body");
    await observe();
    const refused = await call("browser_type", { text: "nope" });
    assert(refused.isError && textOf(refused).includes("Nothing editable has focus"), `typing with nothing focused: ${textOf(refused)}`);

    console.log("BROWSER_CANVAS_CONTROL_OK");
  } finally {
    try { manager.destroy(); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await removeUserData(app.getPath("userData"));
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_CANVAS_CONTROL_FAIL", error);
    app.exit(1);
  },
);
