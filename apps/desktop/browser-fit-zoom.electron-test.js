/**
 * FIT MODE IS A REFLOW, NEVER A ZOOM — in a real Electron.
 *
 * The Dev regression: switching a tab to "Fit panel" and resizing the panel
 * visibly zoomed the page instead of reflowing it. Cause: visible fit tabs
 * were emulated at the stage size, and every frame in which the (async)
 * emulation lagged the native `setBounds`, or the recorded size disagreed
 * with the bounds, Chromium scaled the stale emulated viewport into the
 * rect. The fix: a fit tab ON SCREEN has NO emulation — it lays out for its
 * native bounds like an ordinary browser.
 *
 * Measured here, through fixed → fit and repeated panel resizes:
 *   · `presentation.scale` is 1 and the native rect IS the stage;
 *   · a 20px CSS element and a 24px heading measure exactly that in CSS px
 *     (`getBoundingClientRect`) at every size — zoom would change them;
 *   · `innerWidth/innerHeight` equal the stage;
 *   · the page's `visualViewport.scale` is 1 and `devicePixelRatio` matches
 *     the window's (emulation with `scale` changes what the page reports);
 *   · a native click at a CSS point lands at that CSS point (a zoomed view
 *     would map it elsewhere);
 *   · hidden again, the last meaningful size is retained and emulated for
 *     the background agent, and a click there still lands.
 *
 * Run: `bun run test:desktop:fit-zoom` from apps/desktop
 * (own temp userData, window shown inactive, no focus).
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-fit-zoom-")));

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Fit zoom</title>
<style>
  body { margin:0; font:20px/1 system-ui; }
  h1 { font-size:24px; line-height:24px; margin:16px; height:24px; }
  #box { position:absolute; left:100px; top:100px; width:200px; height:60px; background:#7255ba; }
  #probe { position:absolute; left:0; top:0; width:20px; height:20px; }
</style></head><body>
<h1 id="h">Heading</h1><div id="box"></div><div id="probe"></div>
<div id="click">none</div>
<script>
  addEventListener('click', (e) => { document.getElementById('click').textContent = e.clientX + ',' + e.clientY; });
</script></body></html>`;

function assert(condition, message) { if (!condition) throw new Error(message); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
async function evaluate(manager, tab, expression) {
  // Read without ensureDebugger: verification must not repair geometry.
  return tab.view.webContents.executeJavaScript(expression);
}
const METRICS = `({
  inner: [innerWidth, innerHeight],
  vv: [visualViewport.width, visualViewport.height, visualViewport.scale],
  dpr: devicePixelRatio,
  h: (() => { const r = document.getElementById('h').getBoundingClientRect(); return [r.width, r.height, parseFloat(getComputedStyle(document.getElementById('h')).fontSize)]; })(),
  box: (() => { const r = document.getElementById('box').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })(),
  probe: document.getElementById('probe').getBoundingClientRect().width,
})`;
async function settle(manager, tab) {
  for (let i = 0; i < 50; i += 1) {
    if (!tab.loading && (await evaluate(manager, tab, "document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("page did not settle");
}
async function untilInner(manager, tab, width, height) {
  for (let i = 0; i < 40; i += 1) {
    const m = await evaluate(manager, tab, METRICS);
    if (m.inner[0] === width && m.inner[1] === height) return m;
    await delay(50);
  }
  return evaluate(manager, tab, METRICS);
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => console.log(`FIT_ZOOM ${line}`);

  const window = new BrowserWindow({ show: false, width: 1200, height: 800 });
  window.showInactive();
  const manager = new DesktopBrowserManager(window);
  try {
    manager.declareProfile("s", "none");
    manager.setBounds("s", { x: 0, y: 0, width: 1000, height: 700 });
    await manager.setVisible("s", true);
    // The HUMAN path, fit by default.
    await manager.action("s", { action: "new", url: `${base}/` });
    const tab = manager.activeTab("s");
    await settle(manager, tab);
    const nativeDpr = await evaluate(manager, tab, "devicePixelRatio");

    const checkNative = async (label, width, height) => {
      const m = await untilInner(manager, tab, width, height);
      const p = manager.state("s").presentation;
      const rect = tab.view.getBounds();
      note(`${label}: inner=${m.inner} vv=${m.vv} dpr=${m.dpr} h=${m.h} box=${m.box} probe=${m.probe} scale=${p.scale} rect=${JSON.stringify(rect)} override=${tab.viewportOverride}`);
      assert(m.inner[0] === width && m.inner[1] === height, `${label}: page not laid out for the stage (${m.inner})`);
      assert(tab.view.webContents.getZoomFactor() === 1, `${label}: browser zoom factor changed`);
      assert(p.scale === 1, `${label}: presentation scale ${p.scale} — fit must not scale`);
      assert(rect.width === width && rect.height === height, `${label}: native rect is not the stage`);
      assert(m.vv[2] === 1 && Math.abs(m.vv[0] - width) < 1, `${label}: visual viewport scaled (${m.vv})`);
      assert(m.dpr === nativeDpr, `${label}: devicePixelRatio changed (${m.dpr} vs ${nativeDpr}) — emulation is on`);
      assert(m.h[1] === 24 && m.h[2] === 24, `${label}: heading is not 24 CSS px (${m.h}) — zoomed`);
      assert(m.probe === 20, `${label}: 20px probe measures ${m.probe} — zoomed`);
      assert(m.box[0] === 100 && m.box[1] === 100 && m.box[2] === 200 && m.box[3] === 60, `${label}: box moved/scaled (${m.box})`);
      assert(tab.viewportOverride === "native", `${label}: an emulation override is set (${tab.viewportOverride})`);
      // Pixel evidence as well as CSS metrics: emulation scaling can leave
      // getBoundingClientRect unchanged while shrinking the rendered box.
      const shot = await tab.view.webContents.capturePage();
      const imageSize = shot.getSize();
      const pixels = shot.toBitmap();
      const ratio = imageSize.width / width;
      const y = Math.round(120 * ratio);
      const purple = [];
      for (let x = 0; x < imageSize.width; x += 1) {
        const offset = (y * imageSize.width + x) * 4;
        if (pixels[offset] === 186 && pixels[offset + 1] === 85 && pixels[offset + 2] === 114) purple.push(x);
      }
      assert(Math.abs(purple.length - 200 * ratio) <= 2, `${label}: rendered box width ${purple.length}, expected ${200 * ratio}`);
      assert(Math.abs(purple[0] - 100 * ratio) <= 2, `${label}: rendered box offset ${purple[0]}`);
      note(`${label}: rendered box width=${purple.length}, pixels per CSS px=${ratio}`);
      return m;
    };

    // ── 1. fit by default at 1000×700, then repeated panel resizes ──
    await checkNative("fit 1000×700", 1000, 700);
    for (const [w, h] of [[640, 400], [900, 500], [500, 650], [1000, 700], [640, 400]]) {
      manager.setBounds("s", { x: 0, y: 0, width: w, height: h });
      await tab.geometry.queue;
      await checkNative(`fit resized to ${w}×${h}`, w, h);
    }

    // ── 2. FIXED → FIT: from a scaled fixed preset back to native fit ──
    await manager.action("s", { action: "resize", preset: "default" });
    await tab.geometry.queue;
    const fixed = await untilInner(manager, tab, 1280, 800);
    const fixedScale = manager.state("s").presentation.scale;
    note(`fixed default in 640×400: inner=${fixed.inner} scale=${fixedScale} h=${fixed.h} override=${tab.viewportOverride}`);
    assert(fixed.inner[0] === 1280 && fixedScale === 0.5, "fixed preset did not scale to fit");
    await manager.action("s", { action: "resize", mode: "fit" });
    await tab.geometry.queue;
    await checkNative("fit after fixed", 640, 400);
    // Rapid toggles and resizes interleaved — the last state wins, native.
    await Promise.all([
      manager.action("s", { action: "resize", preset: "phone" }),
      manager.action("s", { action: "resize", mode: "fit" }),
      manager.action("s", { action: "resize", preset: "tablet" }),
      manager.action("s", { action: "resize", mode: "fit" }),
    ]);
    manager.setBounds("s", { x: 0, y: 0, width: 800, height: 600 });
    manager.setBounds("s", { x: 0, y: 0, width: 760, height: 560 });
    await tab.geometry.queue;
    await checkNative("fit after rapid toggles + resizes", 760, 560);

    // ── 3. a native click at a CSS point lands there (no zoom mapping) ──
    tab.view.webContents.sendInputEvent({ type: "mouseDown", x: 150, y: 120, button: "left", clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: "mouseUp", x: 150, y: 120, button: "left", clickCount: 1 });
    await delay(150);
    const clicked = await evaluate(manager, tab, "document.getElementById('click').textContent");
    note(`native click at (150,120) → page saw ${clicked}`);
    assert(clicked === "150,120", `click mapped through a zoom: ${clicked}`);

    // ── 4. hidden: retains 760×560, emulated for the background agent ──
    manager.setBounds("s", { x: 0, y: 0, width: 30, height: 20 }); // closing frame
    await manager.setVisible("s", false);
    await tab.geometry.queue;
    const hidden = await untilInner(manager, tab, 760, 560);
    note(`hidden: inner=${hidden.inner} override=${tab.viewportOverride} state=${JSON.stringify(manager.state("s").tabs[0].viewport)}`);
    assert(hidden.inner[0] === 760 && hidden.inner[1] === 560, `hidden fit tab did not retain 760×560 (${hidden.inner})`);
    assert(tab.viewportOverride === "760x560@1", `hidden fit tab is not emulated at the retained size (${tab.viewportOverride})`);
    // Shown again at a new size: native once more.
    manager.setBounds("s", { x: 0, y: 0, width: 1000, height: 700 });
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    await checkNative("fit re-shown at 1000×700", 1000, 700);

    console.log("BROWSER_FIT_ZOOM_OK");
  } finally {
    try { manager.destroy(); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(app.getPath("userData"), { recursive: true, force: true });
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_FIT_ZOOM_FAIL", error);
    app.exit(1);
  },
);
