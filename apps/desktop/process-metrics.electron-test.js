/**
 * THE PROCESS-METRICS SURFACE, MEASURED IN A REAL ELECTRON — issue #488.
 *
 * `process-metrics.test.js` proves the arithmetic against `ProcessMetric`
 * objects written by hand. Four things it CANNOT prove, and they are the four
 * this file exists for:
 *
 *   1. THAT REAL METRICS HAVE THE FIELDS THE FOLD READS. `cumulativeCPUUsage`
 *      is optional in Electron's own typings, and it is the field that makes
 *      the whole design work: rates taken from it are over a window the caller
 *      chose, which is what keeps the #487 watchdog's thirty-second average
 *      intact while a page samples every two seconds. If this Electron stopped
 *      reporting it the code would silently fall back to `percentCPUUsage` and
 *      that guarantee would quietly be gone — so its presence is asserted here,
 *      where a real `app.getAppMetrics()` can answer.
 *
 *   2. THAT THE RATE MATHS PRODUCES A SANE NUMBER against real readings. The
 *      main process is made to burn a known slice of a known window, and the
 *      Main bucket has to show it. Hand-written cumulative seconds cannot fail
 *      this; a units error between seconds, milliseconds and percent can.
 *
 *   3. THAT "THIS RENDERER IS HOSTING A PAGE" IS ACTUALLY TRUE OF A RENDERER
 *      HOSTING A PAGE. The join is between `app.getAppMetrics()` pids and
 *      `webContents.getOSProcessId()` — two different Electron APIs that a mock
 *      can only be assumed to agree.
 *
 *   4. THAT THE ANSWER SURVIVES THE TWO WAYS OUT OF THE MAIN PROCESS: the
 *      contextBridge (structured clone, where an absent field and an
 *      `undefined` one are not the same thing) and the control server's
 *      loopback JSON, which is the wire `/api/desktop/metrics` proxies.
 *
 * #622's lesson is the reason this file was written rather than skipped:
 * `browser-persistence` asserted a partition name the registry had stopped
 * minting and sat green for days, because green is what a test nobody runs
 * looks like. A contract test against a shape nobody has checked against the
 * platform is the same bug one layer down.
 *
 * Nothing here reaches the network. The window is never shown, the temp
 * userData is removed at the end, and the process exits.
 *
 * Run: `bun run test:desktop:metrics`.
 */
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProcessMetricsReader } = require("./process-metrics");
const { startBrowserControlServer } = require("./browser-control-server");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-process-metrics-"));
app.setPath("userData", userData);

const CONTROL_TOKEN = "metrics-" + "z".repeat(16);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const note = (line) => console.log(`PROCESS_METRICS ${line}`);

/** main.js's own reading, copied here because requiring main.js would start the
 *  whole app. The point of the copy is assertion 3: these pids and the metrics'
 *  pids are produced by different APIs and have to line up. */
function liveRendererProcessIds() {
  const pids = [];
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      const pid = contents.getOSProcessId();
      if (pid) pids.push(pid);
    } catch {
      // Same tolerance main.js has: a WebContents that will not name its
      // process is one we cannot exclude by pid.
    }
  }
  return pids;
}

/** Burn one core for `ms`, in THIS process, so the Main bucket has something
 *  it must report. A sleep would prove nothing: zero is what a broken rate
 *  calculation returns too. */
function burnMainProcess(ms) {
  const until = Date.now() + ms;
  let sink = 0;
  while (Date.now() < until) sink += Math.sqrt(sink + 1);
  return sink;
}

function findType(summary, type) {
  return summary.types.find((entry) => entry.type === type);
}

async function main() {
  // ── 1. the field the whole design rests on ────────────────────────────────
  const raw = app.getAppMetrics();
  assert(Array.isArray(raw) && raw.length > 0, "app.getAppMetrics() reported no processes at all");
  const browser = raw.find((metric) => metric.type === "Browser");
  assert(browser, `no Browser-type process in ${raw.map((m) => m.type).join(", ")}`);
  note(`${raw.length} processes: ${[...new Set(raw.map((m) => m.type))].sort().join(", ")}`);
  assert(
    typeof browser.cpu?.cumulativeCPUUsage === "number" && Number.isFinite(browser.cpu.cumulativeCPUUsage),
    "this Electron reports no cumulativeCPUUsage — process-metrics.js would silently fall back to percentCPUUsage, and with it the guarantee that the #487 watchdog keeps a thirty-second window while the Usage page samples every two seconds. See the header of process-metrics.js before deleting this assertion.",
  );
  assert(
    typeof browser.memory?.workingSetSize === "number",
    "a real ProcessMetric has no memory.workingSetSize — the memory column reads every figure through it",
  );

  const reader = createProcessMetricsReader({
    readMetrics: () => app.getAppMetrics(),
    readLiveProcessIds: liveRendererProcessIds,
    // No throttle: this test drives the clock by doing work, not by waiting.
    minIntervalMs: 0,
  });

  // A window, so there is a renderer that really is hosting a page.
  const page = path.join(userData, "page.html");
  fs.writeFileSync(page, "<!doctype html><title>metrics fixture</title><body>ok</body>");
  const window = new BrowserWindow({
    show: false,
    width: 600,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The handler main.js registers, registered here for the same reason
  // `liveRendererProcessIds` is copied: requiring main.js would start the app.
  ipcMain.handle("telar:metrics:read", () => reader.summary());

  const control = await startBrowserControlServer({
    port: 0,
    token: CONTROL_TOKEN,
    getBrowserManager: () => null,
    readProcessMetrics: () => reader.summary(),
  });

  try {
    await window.loadFile(page);
    const rendererPid = window.webContents.getOSProcessId();
    assert(rendererPid > 0, "the window's renderer would not name its OS process");

    // ── 2. a known slice of a known window ────────────────────────────────
    const cold = reader.summary();
    assert(cold.windowMs === 0, `one sample is not a rate, but the reader reported a ${cold.windowMs}ms window`);
    assert(cold.totals.processes > 0, "the first summary reported no processes");

    burnMainProcess(250);
    const hot = reader.summary();
    assert(hot.windowMs > 0, "the second summary still reported no window to have measured over");
    const mainBucket = findType(hot, "Browser");
    assert(mainBucket, "no Main bucket in the second summary");
    note(`main process at ${mainBucket.cpuPercent.toFixed(1)}% over ${hot.windowMs}ms after burning 250ms`);
    // A quarter-second of solid work inside a window barely longer than that is
    // most of a core. The bar is deliberately far below that: what is being
    // caught is a units error — seconds read as milliseconds, a fraction read
    // as a percentage — not a scheduling wobble on a shared runner.
    assert(
      mainBucket.cpuPercent > 5,
      `the main process burned 250ms of a ${hot.windowMs}ms window and the fold reported ${mainBucket.cpuPercent}% — the rate maths does not agree with real cumulative readings`,
    );
    assert(
      mainBucket.cpuPercent < 100 * (os.cpus().length + 1),
      `the fold reported ${mainBucket.cpuPercent}% for one process, which is more core than this machine has`,
    );

    // ── 3. the join between two different Electron APIs ───────────────────
    //
    // ASSERTED ON THE RAW METRICS FIRST, because this is the only part of it
    // that is exactly true: `app.getAppMetrics()` and
    // `webContents.getOSProcessId()` must agree that this window's renderer is
    // one process. Everything #487 decides rests on that equality, and a mock
    // can only assume it.
    assert(
      liveRendererProcessIds().includes(rendererPid),
      "the live-pid reading did not include the pid of the only window open",
    );
    assert(
      app.getAppMetrics().some((metric) => metric.pid === rendererPid && metric.type === "Tab"),
      `getAppMetrics() reports no Tab-type process with pid ${rendererPid}, which webContents says is this window's renderer — the two APIs are not naming the same processes`,
    );

    const renderers = findType(hot, "Tab");
    assert(renderers, `no renderer bucket in ${hot.types.map((entry) => entry.label).join(", ")}`);
    note(`${renderers.count} renderer(s), ${renderers.pagelessCount} with no page; window pid ${rendererPid}`);
    // AT LEAST ONE RENDERER IS RECOGNISED AS SHOWING A PAGE — not "none are
    // page-less", deliberately. Chromium keeps a spare renderer process around
    // that hosts no WebContents and is a perfectly correct page-less renderer;
    // asserting zero would make this test fail for a Chromium detail rather
    // than for the join it is about.
    assert(
      renderers.count >= 1 && renderers.pagelessCount < renderers.count,
      `${renderers.count} renderer(s) and ${renderers.pagelessCount} reported as showing no page — the window that is plainly showing one was not recognised, which is the signal #487 rests on`,
    );

    // ── 4a. out through the contextBridge ─────────────────────────────────
    const throughBridge = await window.webContents.executeJavaScript(
      "window.telarDesktop && window.telarDesktop.metrics ? window.telarDesktop.metrics.read() : null",
    );
    assert(throughBridge, "preload.js exposed no telarDesktop.metrics bridge to a real renderer");
    assert(Array.isArray(throughBridge.types) && throughBridge.types.length > 0, "the bridge answered with no process types");
    assert(
      typeof throughBridge.totals?.cpuPercent === "number" && typeof throughBridge.totals?.processes === "number",
      "the totals did not survive the structured clone across the contextBridge",
    );
    // The field that is OMITTED rather than set to undefined, because
    // structured clone treats those differently and the UI branches on
    // `hostsPage === false` rather than on falsiness.
    const bridgedRenderer = throughBridge.busiest.find((row) => row.type === "Tab");
    if (bridgedRenderer) {
      assert(
        bridgedRenderer.hostsPage === true || bridgedRenderer.hostsPage === false,
        `a renderer crossed the bridge with hostsPage=${bridgedRenderer.hostsPage} — the page column cannot be read from that`,
      );
    }
    note(`bridge answered ${throughBridge.totals.processes} processes over ${throughBridge.windowMs}ms`);

    // ── 4b. out through the loopback wire /api/desktop/metrics proxies ────
    const unauthorized = await fetch(`http://127.0.0.1:${control.port}/metrics`);
    assert(unauthorized.status === 401, `the control server answered ${unauthorized.status} to an unauthenticated /metrics`);
    const response = await fetch(`http://127.0.0.1:${control.port}/metrics`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    assert(response.status === 200, `the control server answered ${response.status} to /metrics`);
    const overWire = await response.json();
    assert(Array.isArray(overWire.types) && overWire.types.length > 0, "the control server answered with no process types");
    assert(
      typeof overWire.readAt === "number" && overWire.readAt > 0,
      "the control server's answer carried no read time, so a stale sample could not be told from a fresh one",
    );
    assert(
      overWire.types.every((entry) => typeof entry.label === "string" && typeof entry.cpuPercent === "number"),
      "a process type crossed the wire without the fields the Usage page reads",
    );
    note(`control server answered ${overWire.totals.processes} processes`);

    console.log("PROCESS_METRICS_OK");
  } finally {
    ipcMain.removeHandler("telar:metrics:read");
    await control.close();
    window.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("PROCESS_METRICS_FAIL", error);
    app.exit(1);
  },
);
