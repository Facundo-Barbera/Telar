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
const { removeUserData } = require("./electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-process-metrics-"));
app.setPath("userData", userData);

const CONTROL_TOKEN = "metrics-" + "z".repeat(16);

/**
 * A HANG IS A FAILURE, AND MUST LOOK LIKE ONE.
 *
 * The CI job's own note says a tier that cannot fail is the same bug as a tier
 * that never runs. A test that hangs is the third version of that: it burns the
 * job's whole 25-minute budget, reports nothing about the code, and the only
 * thing anybody learns is that a macOS runner was busy. So this file holds
 * itself to a deadline and says which step it was on when it expired.
 *
 * Generous on purpose — the work here is milliseconds, and the margin is for a
 * shared runner rather than for anything this test does.
 */
const DEADLINE_MS = 60_000;
let stage = "app.whenReady()";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const note = (line) => console.log(`PROCESS_METRICS ${line}`);
const at = (next) => {
  stage = next;
  note(`… ${next}`);
};

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
  at("reading app.getAppMetrics()");
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
  at("opening a window");
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
      // MATCHING `createWindow` IN main.js, and load-bearing here rather than
      // cosmetic: this window is never shown, and Chromium throttles a hidden
      // renderer's task queues. The real cockpit window turns it off, so a test
      // that left it on would be asking a question about a configuration the
      // product does not ship.
      backgroundThrottling: false,
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
    at("loading the fixture page");
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
    //
    // THE ANSWER IS STASHED ON THE PAGE AND READ BACK AS A PLAIN VALUE, rather
    // than returned as a promise for `executeJavaScript` to await. Handing it a
    // pending promise makes exactly one outcome — "the invoke never came back" —
    // indistinguishable from a hang, and a hang in this tier costs the job's
    // whole budget and reports nothing. Polling a plain object instead lets the
    // three outcomes be told apart: no bridge, a rejection with its reason, or
    // an invoke that is still outstanding after a bounded wait.
    at("reading the bridge from a real renderer");
    const started = await window.webContents.executeJavaScript(`
      (function () {
        if (!window.telarDesktop || !window.telarDesktop.metrics) return "no-bridge";
        window.__telarMetrics = { state: "pending" };
        window.telarDesktop.metrics.read().then(
          (summary) => { window.__telarMetrics = { state: "ok", summary: summary }; },
          (error) => { window.__telarMetrics = { state: "error", why: String((error && error.message) || error) }; },
        );
        return "started";
      })()
    `);
    assert(started === "started", `preload.js exposed no telarDesktop.metrics bridge to a real renderer (${started})`);

    let bridged = { state: "pending" };
    for (let attempt = 0; attempt < 40 && bridged.state === "pending"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      bridged = await window.webContents.executeJavaScript("window.__telarMetrics");
    }
    // AND THE MESSAGE POINTS AT THE MAIN SIDE, because the symptom is on this
    // one. When `ipcMain.handle` returns something structured clone refuses,
    // Electron throws while SERIALISING the reply — after the handler has
    // returned, inside Electron's own IPC layer. The renderer is told nothing
    // at all: no rejection, no error, just an invoke that never answers. So a
    // `try`/`catch` in the handler cannot help, and the only evidence is a line
    // Electron logged before this one. Say so, or the next reader spends their
    // time on the renderer.
    assert(
      bridged.state !== "pending",
      "telar:metrics:read never answered a real renderer within four seconds. The invoke reached the main process and nothing came back, which is what a handler whose RETURN VALUE cannot be structured-cloned looks like from here — Electron throws while serialising the reply, after the handler returned, and tells the renderer nothing. Look for an 'An object could not be cloned' line above this one, and for a non-plain value (a function, a getter, a Proxy) on the payload in process-metrics.js.",
    );
    assert(bridged.state === "ok", `the bridge rejected: ${bridged.why}`);
    const throughBridge = bridged.summary;
    assert(throughBridge, "the bridge resolved with nothing at all");
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
    //
    // EVERY BODY IS DRAINED, AND THAT IS NOT TIDINESS — it is the whole reason
    // the first version of this file hung a CI job for twenty-five minutes.
    // The main process's `fetch` is Node's (undici): a response whose body is
    // never read holds its connection open, and `server.close()` completes when
    // the last connection ENDS rather than when the port stops listening. So
    // the 401 assertion below, which only ever wanted `.status`, left a socket
    // mid-response and the teardown waited on it for ever. Reading the body of
    // a response you are going to discard looks pointless and is load-bearing.
    at("reading /metrics over loopback");
    const unauthorized = await fetch(`http://127.0.0.1:${control.port}/metrics`, {
      headers: { connection: "close" },
    });
    await unauthorized.text();
    assert(unauthorized.status === 401, `the control server answered ${unauthorized.status} to an unauthenticated /metrics`);
    const response = await fetch(`http://127.0.0.1:${control.port}/metrics`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, connection: "close" },
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
    at("tearing down");
    ipcMain.removeHandler("telar:metrics:read");
    // BOUNDED, because a teardown is not worth hanging a CI job over. The
    // header above should make the close immediate; if some socket outlives it
    // anyway, the process is about to exit and the port goes with it.
    await Promise.race([control.close(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    window.destroy();
    await removeUserData(userData);
  }
}

const deadline = setTimeout(() => {
  console.error(`PROCESS_METRICS_FAIL timed out after ${DEADLINE_MS}ms while: ${stage}`);
  app.exit(1);
}, DEADLINE_MS);

app.whenReady().then(main).then(
  () => {
    clearTimeout(deadline);
    app.exit(0);
  },
  (error) => {
    clearTimeout(deadline);
    console.error("PROCESS_METRICS_FAIL", error);
    app.exit(1);
  },
);
