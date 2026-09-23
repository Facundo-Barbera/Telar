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
 * And two more facts about the view itself:
 *   · a loaded page paints on an OPAQUE WHITE canvas — a pixel the fixture
 *     does not paint reads white, not the transparent nothing that let the
 *     cockpit show through pages with no root background (App Store Connect);
 *   · a FIXED preset in a stage taller than the fitted page sits at the TOP
 *     of the stage, the view is exactly the emulated page (viewport × scale),
 *     and the page's own `position: fixed; bottom: 0` footer sits at the
 *     emulated bottom — nothing of the page can be painted below the frame;
 *   · and the page's own SURFACE is that rect too: its capture is the view's
 *     size with the footer on its last row, not a 1280×800 widget with the
 *     page in its corner and white canvas below (the slab after #922), and
 *     the frozen frame a menu shows is the same picture at the same rect.
 *
 * Run: `bun run test:desktop:fit-zoom` from apps/desktop
 * (own temp userData, window shown inactive, no focus).
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { removeUserData } = require("./electron-test-teardown");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-fit-zoom-")));

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Fit zoom</title>
<style>
  body { margin:0; font:20px/1 system-ui; }
  h1 { font-size:24px; line-height:24px; margin:16px; height:24px; }
  #box { position:absolute; left:100px; top:100px; width:200px; height:60px; background:#7255ba; }
  #probe { position:absolute; left:0; top:0; width:20px; height:20px; }
  #floor { position:fixed; left:0; bottom:0; width:100%; height:20px; background:#1e90ff; }
</style></head><body>
<h1 id="h">Heading</h1><div id="box"></div><div id="probe"></div><div id="floor"></div>
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
  floor: document.getElementById('floor').getBoundingClientRect().bottom,
})`;
/**
 * THE CANVAS IS OPAQUE WHITE. A pixel the fixture does not paint (its body
 * has no background) is read back from the compositor: white, alpha 255.
 * Polled, because `setBackgroundColor` lands on the renderer's next frame.
 */
async function untilOpaqueCanvas(tab, width, height) {
  let seen = null;
  for (let i = 0; i < 40; i += 1) {
    const shot = await tab.view.webContents.capturePage();
    const size = shot.getSize();
    const ratio = size.width / width;
    const x = Math.round((width - 40) * ratio);
    const y = Math.round((height - 40) * ratio);
    const pixels = shot.toBitmap();
    const offset = (y * size.width + x) * 4;
    // BGRA: an opaque white is 255 in every channel; the old transparent
    // canvas read 0 in every channel.
    seen = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
    if (seen.every((channel) => channel === 255)) return seen;
    await delay(50);
  }
  return seen;
}
/** The fixture's footer, BGRA. */
const FLOOR = [255, 144, 30, 255];
/**
 * What a captured surface shows of a view `width`×`height` CSS px: its size,
 * whether that IS the view at the window's device ratio, the middle pixel
 * of its bottom row, and where the purple box starts (x) and its row (y).
 */
function surfaceFacts(image, width, height, dpr) {
  const size = image.getSize();
  const ratio = size.width / width;
  const pixels = image.toBitmap();
  const at = (x, y) => { const o = (y * size.width + x) * 4; return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]]; };
  const bottom = at(Math.round(size.width / 2), size.height - 1);
  let box = [-1, -1];
  for (let y = 0; y < size.height && box[0] < 0; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const p = at(x, y);
      if (p[0] === 186 && p[1] === 85 && p[2] === 114) { box = [x, y]; break; }
    }
  }
  return { size, ratio, matches: Math.abs(size.width - width * dpr) <= 1 && Math.abs(size.height - height * dpr) <= 1, bottom, box };
}
/** Polled: the widget resize and its next frame land after the CDP call. */
async function untilSurface(tab, width, height, dpr) {
  let facts = null;
  for (let i = 0; i < 40; i += 1) {
    facts = surfaceFacts(await tab.view.webContents.capturePage(), width, height, dpr);
    if (facts.matches && facts.bottom.join() === FLOOR.join()) return facts;
    await delay(50);
  }
  return facts;
}
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
      // The page has a document, so it paints on an opaque white canvas.
      const canvas = await untilOpaqueCanvas(tab, width, height);
      note(`${label}: unpainted pixel reads ${canvas}`);
      assert(canvas.every((channel) => channel === 255), `${label}: the canvas under the page is not opaque white (BGRA ${canvas}) — the cockpit shows through`);
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
    // A stage TALLER than the fitted page: 1280×800 in 640×600 is 640×400 at
    // 0.5, placed at the TOP of the stage. The view is exactly that page —
    // the emulated size × scale — and the page's fixed footer sits at the
    // emulated bottom (800), so nothing of it can paint below the frame.
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 600 });
    await tab.geometry.queue;
    await manager.action("s", { action: "resize", preset: "default" });
    await tab.geometry.queue;
    const fixed = await untilInner(manager, tab, 1280, 800);
    const fixedScale = manager.state("s").presentation.scale;
    const fixedRect = tab.view.getBounds();
    const presented = manager.state("s").presentation.rect;
    note(`fixed default in 640×600: inner=${fixed.inner} vv=${fixed.vv} floor=${fixed.floor} scale=${fixedScale} rect=${JSON.stringify(fixedRect)} presented=${JSON.stringify(presented)} h=${fixed.h} override=${tab.viewportOverride}`);
    assert(fixed.inner[0] === 1280 && fixed.inner[1] === 800 && fixedScale === 0.5, `fixed preset did not lay out at 1280×800 scaled 0.5 (${fixed.inner} @ ${fixedScale})`);
    assert(fixedRect.x === 0 && fixedRect.y === 0 && fixedRect.width === 640 && fixedRect.height === 400, `fixed view is not the top-aligned fitted page: ${JSON.stringify(fixedRect)}`);
    assert(presented.x === 0 && presented.y === 0 && presented.width === 640 && presented.height === 400, `the presentation rect ${JSON.stringify(presented)} is not the view's`);
    assert(fixed.floor === 800, `the page's fixed footer bottoms out at ${fixed.floor}, not the emulated 800 — the page is laid out for something other than the emulated height`);
    // THE WIDGET IS THE VIEW, NOT THE OVERRIDE (the white slab after #922).
    // `view.getBounds()` is only what was asked for; the page's own surface is
    // what paints. Chromium used to grow it to 1280×800 behind a 640×400 view,
    // page in the corner and opaque canvas below it down to the window edge.
    // So: the surface is the view's size, and its bottom row is the page's
    // own footer — no canvas below the fitted rect.
    const live = await untilSurface(tab, 640, 400, nativeDpr);
    note(`fixed surface: ${JSON.stringify(live.size)} ratio=${live.ratio} bottom=${live.bottom} box=${live.box}`);
    assert(live.matches, `the page's widget is ${JSON.stringify(live.size)}, not the 640×400 view — it overflows the fitted rect`);
    assert(live.bottom.join() === FLOOR.join(), `the surface's bottom row is ${live.bottom}, not the page's footer — canvas below the page`);
    // The box sits at CSS (100, 100); at scale 0.5 that is (50, 50) of the view.
    assert(Math.abs(live.box[0] - 50 * live.ratio) <= 2 && Math.abs(live.box[1] - 50 * live.ratio) <= 2, `the page is not scaled into the full view: box at ${live.box}`);
    // THE FROZEN FRAME IS THE LIVE PAGE: same size, same content, not the
    // page shrunk into a corner of a larger white frame.
    const frame = await manager.freezeView("s");
    assert(frame, "no frozen frame for a shown fixed page");
    assert(JSON.stringify(frame.rect) === JSON.stringify(presented), `frozen rect ${JSON.stringify(frame.rect)} is not the live rect ${JSON.stringify(presented)}`);
    const frozen = surfaceFacts(nativeImage.createFromBuffer(Buffer.from(frame.data, "base64")), 640, 400, nativeDpr);
    note(`frozen frame: ${JSON.stringify(frozen.size)} bottom=${frozen.bottom} box=${frozen.box}`);
    assert(frozen.matches, `frozen frame is ${JSON.stringify(frozen.size)}, not the live ${JSON.stringify(live.size)}`);
    assert(frozen.bottom.join() === FLOOR.join(), `frozen frame's bottom row is ${frozen.bottom} — the page is shrunk inside it`);
    assert(frozen.box.join() === live.box.join(), `frozen box ${frozen.box} is not where the live box is (${live.box})`);
    await manager.setVisible("s", true);
    await tab.geometry.queue;
    await manager.action("s", { action: "resize", mode: "fit" });
    await tab.geometry.queue;
    await checkNative("fit after fixed", 640, 600);
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
    await removeUserData(app.getPath("userData"));
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_FIT_ZOOM_FAIL", error);
    app.exit(1);
  },
);
