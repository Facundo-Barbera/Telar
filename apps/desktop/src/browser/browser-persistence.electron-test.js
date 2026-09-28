const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { createTabStore } = require("./browser-tab-store");
const { readProfileRegistry } = require("./browser-profiles");
const { removeUserData } = require("../../test/electron/electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-browser-persistence-"));
app.setPath("userData", userData);

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Telar viewport acceptance</title>
<style>
  body { margin:0; font:20px system-ui; background:#ecf2fb; color:#15283e; min-height:100vh; }
  header { padding:24px; background:#d5e3f6; }
  #target { position:absolute; left:900px; top:500px; width:220px; height:70px; font:20px system-ui; }
  #edge { position:absolute; left:1200px; top:720px; width:60px; height:60px; background:#7255ba; color:white; }
</style>
<header><h1>Telar viewport acceptance</h1><div id="dimensions"></div><div id="count">Count: 0</div><div id="position">Last click: none</div><div id="marker"></div></header>
<a href="?page=second">Open second fixture page</a>
<button id="target">Increment at 900,500</button>
<div id="edge">Edge</div>
<script>
  let count=0; const $=id=>document.getElementById(id);
  const measure=()=>$('dimensions').textContent='Viewport: '+innerWidth+' x '+innerHeight; measure(); addEventListener('resize',measure);
  $('target').onclick=e=>{ $('count').textContent='Count: '+(++count); $('position').textContent='Last click: '+e.clientX+', '+e.clientY; };
  $('marker').textContent='Page: '+(new URL(location).searchParams.get('page')||'first');
</script></body></html>`;

function textOf(result) { return (result?.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n"); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(manager, tab, expression) {
  const debug = await manager.ensureDebugger(tab);
  return (await debug.sendCommand("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
}
async function settle(manager, tab) {
  for (let i = 0; i < 50; i += 1) {
    if (!tab.loading && (await evaluate(manager, tab, "document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("page did not settle");
}
async function until(fn, expected, tries = 30) {
  for (let i = 0; i < tries; i += 1) { if ((await fn()) === expected) return; await delay(100); }
}
function ref(snapshotText, label) {
  const match = snapshotText.match(new RegExp(`${label}[^\\n]*\\[ref=(e\\d+)\\]`));
  assert(match, `no ref for ${label} in:\n${snapshotText}`);
  return match[1];
}

function decodePng(base64) {
  const zlib = require("node:zlib");
  const bytes = Buffer.from(base64, "base64");
  assert(bytes.toString("ascii", 1, 4) === "PNG", "not a PNG");
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  assert(channels, `unsupported PNG colour type ${colorType}`);
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0; const b = prev[i]; const c = i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a; else if (filter === 2) value += b; else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = value & 0xff;
    }
    prev = out;
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * channels; return [pixels[i], pixels[i + 1], pixels[i + 2]]; } };
}
const isPurple = ([r, g, b]) => Math.abs(r - 0x72) < 24 && Math.abs(g - 0x55) < 24 && Math.abs(b - 0xba) < 24;

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

    if (request.url === "/bounce") return response.end("<!doctype html><script>location.replace('/?page=landed')</script>");

    if (request.url === "/slow") { setTimeout(() => response.end("<!doctype html><title>slow</title>"), 1500); return; }
    response.end(FIXTURE);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => console.log(`PERSISTENCE ${line}`);
  const PROJECT = "project_0123456789abcdef0123456789abcdef";

  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });

  window.showInactive();

  let manager = new DesktopBrowserManager(window, { profiles: readProfileRegistry(userData), tabStore: createTabStore(userData, { writeDelayMs: 10 }) });
  try {
    manager.declareProfile("s1", PROJECT);
    manager.declareProfile("s2", "none");

    manager.setBounds("s1", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s1", true);
    await manager.action("s1", { action: "new", url: `${base}/` });
    const tab = manager.activeTab("s1");
    assert(tab.openedBy === "human", "toolbar tab is not human-opened");
    for (let i = 0; i < 50 && tab.loading; i += 1) await delay(100);
    await delay(400);
    const wc0 = tab.view.webContents;
    const humanSeen = await wc0.executeJavaScript("document.getElementById('dimensions').textContent");
    note(`human-opened tab (fit default), never inspected: ${humanSeen}; state=${JSON.stringify(manager.state("s1").tabs[0].viewport)}`);
    assert(humanSeen === "Viewport: 640 x 400", `fit-default human tab did not lay out for the stage: ${humanSeen}`);
    assert(manager.state("s1").tabs[0].viewport.mode === "fit", "a new tab is not in fit mode");

    manager.setBounds("s1", { x: 0, y: 0, width: 900, height: 500 });
    await delay(400);
    const grown = await tab.view.webContents.executeJavaScript("document.getElementById('dimensions').textContent");
    note(`panel 900×500 in fit: ${grown}; native bounds=${JSON.stringify(tab.view.getBounds())}`);
    assert(grown === "Viewport: 900 x 500", `fit did not follow the panel: ${grown}`);
    assert(JSON.stringify(tab.view.getBounds()) === JSON.stringify({ x: 0, y: 0, width: 900, height: 500 }), "fit view is not the stage");

    await manager.action("s1", { action: "navigate", url: `${base}/?page=nav` });
    for (let i = 0; i < 50 && tab.loading; i += 1) await delay(100);
    await delay(400);
    const afterNav = await tab.view.webContents.executeJavaScript("document.getElementById('dimensions').textContent");
    note(`after human navigate: ${afterNav}`);
    assert(afterNav === "Viewport: 900 x 500", `human navigation lost the viewport: ${afterNav}`);

    manager.setBounds("s1", { x: 0, y: 0, width: 640, height: 400 });
    const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= 640 && b.y + b.height <= 400;
    await Promise.all([
      manager.action("s1", { action: "resize", preset: "phone" }),
      manager.action("s1", { action: "resize", preset: "laptop" }),
      manager.action("s1", { action: "resize", mode: "fit" }),
      manager.action("s1", { action: "resize", preset: "tablet" }),
      manager.action("s1", { action: "resize", mode: "fit" }),
      manager.action("s1", { action: "resize", preset: "default" }),
    ]);
    await tab.geometry.queue;
    await delay(300);
    const rapid = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    const rapidBounds = tab.view.getBounds();
    note(`after rapid switches: viewport ${rapid[0]}×${rapid[1]}, mode=${manager.state("s1").tabs[0].viewport.mode}, native=${JSON.stringify(rapidBounds)}`);
    assert(rapid[0] === 1280 && rapid[1] === 800, "rapid switches did not settle on the last request (default 1280×800)");
    assert(manager.state("s1").tabs[0].viewport.mode === "fixed", "rapid switches did not settle on fixed");
    assert(inside(rapidBounds), `native bounds bleed outside the host: ${JSON.stringify(rapidBounds)}`);

    for (const preset of ["phone", "laptop", "tablet", "default"]) {
      await manager.action("s1", { action: "resize", preset });
      await tab.geometry.queue;
      assert(inside(tab.view.getBounds()), `preset ${preset} bled: ${JSON.stringify(tab.view.getBounds())}`);
    }
    await manager.action("s1", { action: "navigate", url: `${base}/` });
    await settle(manager, tab);

    await until(() => evaluate(manager, tab, "innerWidth"), 1280);
    const inner = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`narrow panel innerWidth×innerHeight = ${inner[0]}×${inner[1]} (bounds 640×400)`);
    assert(inner[0] === 1280 && inner[1] === 800, "narrow panel reflowed the page — intrinsic viewport lost");
    const presentation = manager.state("s1").presentation;
    note(`presentation scale=${presentation.scale} rect=${JSON.stringify(presentation.rect)}`);
    assert(presentation.scale === 0.5, "fit scale is not 0.5");

    let snap = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    const clicked = await manager.callTool("s1", "browser_click", { target: ref(snap, 'button "Increment at 900,500"') });
    assert(!clicked.isError, `agent click under scale errored: ${textOf(clicked)}`);
    await until(() => evaluate(manager, tab, "document.getElementById('count').textContent"), "Count: 1");
    const agentPos = await evaluate(manager, tab, "document.getElementById('position').textContent");
    note(`agent CDP click landed: ${agentPos}`);
    assert(/Last click: 10\d\d, 5[23]\d/.test(agentPos), `agent click did not land on the button in CSS space: ${agentPos}`);

    await delay(500);
    tab.view.webContents.sendInputEvent({ type: "mouseDown", x: 500, y: 265, button: "left", clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: "mouseUp", x: 500, y: 265, button: "left", clickCount: 1 });
    await until(() => evaluate(manager, tab, "document.getElementById('count').textContent"), "Count: 2");
    const humanPos = await evaluate(manager, tab, "document.getElementById('position').textContent");
    note(`native human click at (500,265) landed: ${humanPos}`);
    assert(humanPos === "Last click: 1000, 530", `native input did not map through the scale: ${humanPos}`);

    snap = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    const shot = await manager.callTool("s1", "browser_take_screenshot", {});
    assert(!shot.isError, `screenshot errored: ${textOf(shot)}`);
    const png = decodePng(shot.content[0].data);
    note(`visible screenshot ${png.width}×${png.height}; pixel@(1230,750)=${png.at(1230, 750)} pixel@(615,375)=${png.at(615, 375)}`);
    assert(png.width === 1280 && png.height === 800, "screenshot is not the intrinsic viewport size");
    assert(isPurple(png.at(1230, 750)), "the edge block at CSS (1200,720) is missing — the capture is not the intrinsic layout");
    assert(!isPurple(png.at(615, 375)), "the edge block appears at the SCALED position — the capture was shrunk into a corner");

    const resized = await manager.callTool("s1", "browser_resize", { preset: "phone" });
    assert(!resized.isError, textOf(resized));
    await until(() => evaluate(manager, tab, "innerWidth"), 390);
    const phone = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`after browser_resize phone: innerWidth×innerHeight = ${phone[0]}×${phone[1]}, scale=${manager.state("s1").presentation.scale}`);
    assert(phone[0] === 390 && phone[1] === 844, "resize did not reflow the page");
    assert(manager.bounds.width === 640, "the panel bounds must not change on a resize");
    await manager.callTool("s1", "browser_resize", { preset: "default" });
    await until(() => evaluate(manager, tab, "innerWidth"), 1280);

    const wc = tab.view.webContents;
    await manager.setVisible("s1", false);
    await until(() => evaluate(manager, tab, "innerWidth"), 1280);
    manager.hideVisibleScope();
    assert(tab.view && tab.view.webContents === wc, "the renderer reload released the page an agent may be working in");
    await manager.callTool("s1", "browser_navigate", { url: `${base}/?page=second` });
    await settle(manager, tab);
    assert((await evaluate(manager, tab, "document.getElementById('marker').textContent")) === "Page: second", "hidden navigate did not land");
    snap = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    const hiddenClick = await manager.callTool("s1", "browser_click", { target: ref(snap, 'button "Increment at 900,500"') });
    assert(!hiddenClick.isError, `hidden click errored: ${textOf(hiddenClick)}`);
    await until(() => evaluate(manager, tab, "document.getElementById('count').textContent"), "Count: 1");
    const hiddenPos = await evaluate(manager, tab, "document.getElementById('position').textContent");
    note(`hidden click landed: ${hiddenPos}`);
    assert(/Last click: 10\d\d, 5[23]\d/.test(hiddenPos), `hidden click missed: ${hiddenPos}`);
    const hiddenShot = await manager.callTool("s1", "browser_take_screenshot", {});
    assert(!hiddenShot.isError, `hidden screenshot errored: ${textOf(hiddenShot)}`);
    const hiddenPng = decodePng(hiddenShot.content[0].data);
    note(`hidden screenshot ${hiddenPng.width}×${hiddenPng.height}; pixel@(1230,750)=${hiddenPng.at(1230, 750)}`);
    assert(hiddenPng.width === 1280 && hiddenPng.height === 800 && isPurple(hiddenPng.at(1230, 750)), "hidden screenshot is not the intrinsic layout");

    manager.setBounds("s1", { x: 0, y: 0, width: 700, height: 450 });
    await manager.setVisible("s1", true);
    await manager.action("s1", { action: "resize", mode: "fit" });
    await until(() => evaluate(manager, tab, "innerWidth"), 700);
    manager.setBounds("s1", { x: 0, y: 0, width: 40, height: 30 });
    await manager.setVisible("s1", false);
    await tab.geometry.queue;
    await delay(200);
    const retained = await evaluate(manager, tab, "[innerWidth, innerHeight]");
    note(`fit tab hidden after a 40×30 frame: viewport ${retained[0]}×${retained[1]}`);
    assert(retained[0] === 700 && retained[1] === 450, "hidden fit tab did not retain the last meaningful size");
    snap = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    const fitHiddenClick = await manager.callTool("s1", "browser_click", { target: ref(snap, 'button "Increment at 900,500"') });
    note(`hidden fit-mode click: ${fitHiddenClick.isError ? textOf(fitHiddenClick).slice(0, 80) : "ok"}`);

    assert(!fitHiddenClick.isError, `hidden fit click errored: ${textOf(fitHiddenClick)}`);
    await manager.action("s1", { action: "resize", preset: "default" });

    const replaced = await manager.action("s1", { action: "navigate", url: `${base}/bounce` });
    await settle(manager, tab);
    note(`replacement navigation: state.error=${replaced.error} url=${tab.url}`);
    assert(tab.url.endsWith("/?page=landed"), `replacement did not land: ${tab.url}`);
    let dead = null;
    try { await manager.action("s1", { action: "navigate", url: "http://127.0.0.1:9/" }); } catch (error) { dead = error; }
    note(`dead address: ${dead ? String(dead.message).slice(0, 70) : "NO ERROR"}`);
    assert(dead, "a genuinely failed navigation was swallowed");
    const agentReplaced = await manager.callTool("s1", "browser_navigate", { url: `${base}/bounce` });
    await settle(manager, tab);
    note(`agent replacement navigate: ${textOf(agentReplaced)}`);
    assert(!agentReplaced.isError, `agent navigate reported the supersede as a failure: ${textOf(agentReplaced)}`);

    const first = manager.action("s1", { action: "navigate", url: `${base}/slow` });
    await delay(150);
    const second = manager.action("s1", { action: "navigate", url: `${base}/?page=landed` });
    const [firstState, secondState] = await Promise.all([first, second]);
    await settle(manager, tab);
    note(`superseded navigation: first→${firstState.tabs[0].url.split("/").pop()} second→${secondState.tabs[0].url.split("/").pop()} final=${tab.url}`);
    assert(tab.url.endsWith("/?page=landed"), `superseded navigation did not land on the replacement: ${tab.url}`);

    await manager.callTool("s1", "browser_tabs", { action: "new", url: `${base}/?page=closed` });
    await manager.callTool("s1", "browser_tabs", { action: "new", url: `${base}/?page=third` });
    await settle(manager, manager.activeTab("s1"));
    await manager.resizeTab(manager.activeTab("s1"), { preset: "tablet" });
    await manager.callTool("s1", "browser_tabs", { action: "close", index: 1 });
    await manager.callTool("s1", "browser_tabs", { action: "select", index: 0 });
    await manager.callTool("s2", "browser_tabs", { action: "new", url: `${base}/?page=other` });

    await manager.callTool("s2", "browser_tabs", { action: "new", url: `${base}/?page=ext` });
    const fakeExt = manager.scopeTabs("s2")[1];
    manager.hibernateTab(fakeExt);
    fakeExt.url = "chrome-extension://abcdef/unlock.html";
    const before = manager.state("s1").tabs.map((t) => [t.url, t.active, t.viewport.preset]);

    const partitionBefore = { s1: manager.scopeTabs("s1")[0].partition, s2: manager.scopeTabs("s2")[0].partition };
    note(`before quit s1: ${JSON.stringify(before)}; partitions=${JSON.stringify(partitionBefore)}`);
    manager.destroy();
    const written = JSON.parse(fs.readFileSync(path.join(userData, "browser-tabs.json"), "utf8"));
    assert(!JSON.stringify(written).includes("chrome-extension"), "an extension page was persisted");
    assert(!JSON.stringify(written).includes("page=closed"), "a closed tab was persisted");

    const profiles = readProfileRegistry(userData);
    manager = new DesktopBrowserManager(window, { profiles, tabStore: createTabStore(userData, { writeDelayMs: 10 }) });
    const restored = manager.state("s1");
    note(`after restart s1: ${JSON.stringify(restored.tabs.map((t) => [t.url, t.active, t.sleeping, t.viewport.preset]))}`);
    assert(restored.tabs.length === 2, `expected 2 restored tabs, got ${restored.tabs.length}`);
    assert(restored.tabs.every((t) => t.sleeping), "restored tabs must be sleeping (no eager navigation)");
    assert(restored.tabs[0].active && restored.tabs[0].url.endsWith("?page=landed"), "active tab / order not restored");

    assert(restored.tabs[0].viewport.preset === "ipad-mini", "per-tab viewport not restored");
    assert(manager.profileOf("s1") === PROJECT && manager.profileOf("s2") === "none", "profiles not restored");
    assert(manager.state("s2").tabs.length === 1, "the extension page came back");
    assert(manager.tabs.every((t) => !t.view), "a restore navigated something at startup");

    const wakeSnap = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    assert(wakeSnap.includes("page=landed"), "the woken tab is not the remembered active one");
    await settle(manager, manager.activeTab("s1"));
    const live = manager.tabs.filter((t) => t.view);
    note(`after first use: ${live.length} live view(s), partition=${live[0].partition}`);
    assert(live.length === 1, "more than one tab woke");

    assert(live[0].partition === partitionBefore.s1, `restored tab is in the wrong partition: ${live[0].partition}, was ${partitionBefore.s1}`);
    assert(live[0].partition === profiles.resolve(PROJECT).partition, `restored tab is not where the registry resolves ${PROJECT}: ${live[0].partition} vs ${profiles.resolve(PROJECT).partition}`);
    assert((await evaluate(manager, live[0], "document.getElementById('marker').textContent")) === "Page: landed", "restored page did not load on wake");

    assert(manager.scopeTabs("s2")[0].partition === partitionBefore.s2, `restored s2 partition wrong: ${manager.scopeTabs("s2")[0].partition}, was ${partitionBefore.s2}`);
    assert(manager.scopeTabs("s2")[0].partition === profiles.resolve("none").partition, "restored s2 is not where the registry resolves the projectless key");

    console.log("BROWSER_PERSISTENCE_OK");
  } finally {
    try { manager.destroy(); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await removeUserData(userData);
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("BROWSER_PERSISTENCE_FAIL", error);
    app.exit(1);
  },
);
