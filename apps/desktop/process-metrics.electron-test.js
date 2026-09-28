const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProcessMetricsReader } = require("./process-metrics");
const serviceWorkerWatchdog = require("./service-worker-watchdog");
const { startBrowserControlServer } = require("./browser-control-server");
const { removeUserData } = require("./electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-process-metrics-"));
app.setPath("userData", userData);

const CONTROL_TOKEN = "metrics-" + "z".repeat(16);

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

function liveRendererProcessIds() {
  const pids = [];
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      const pid = contents.getOSProcessId();
      if (pid) pids.push(pid);
    } catch {
    }
  }
  return pids;
}

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

    minIntervalMs: 0,
  });

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

      backgroundThrottling: false,
    },
  });

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

    const cold = reader.summary();
    assert(cold.windowMs === 0, `one sample is not a rate, but the reader reported a ${cold.windowMs}ms window`);
    assert(cold.totals.processes > 0, "the first summary reported no processes");

    burnMainProcess(250);
    const hot = reader.summary();
    assert(hot.windowMs > 0, "the second summary still reported no window to have measured over");
    const mainBucket = findType(hot, "Browser");
    assert(mainBucket, "no Main bucket in the second summary");
    note(`main process at ${mainBucket.cpuPercent.toFixed(1)}% over ${hot.windowMs}ms after burning 250ms`);

    assert(
      mainBucket.cpuPercent > 5,
      `the main process burned 250ms of a ${hot.windowMs}ms window and the fold reported ${mainBucket.cpuPercent}% — the rate maths does not agree with real cumulative readings`,
    );
    assert(
      mainBucket.cpuPercent < 100 * (os.cpus().length + 1),
      `the fold reported ${mainBucket.cpuPercent}% for one process, which is more core than this machine has`,
    );

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

    assert(
      renderers.count >= 1 && renderers.pagelessCount < renderers.count,
      `${renderers.count} renderer(s) and ${renderers.pagelessCount} reported as showing no page — the window that is plainly showing one was not recognised, which is the signal #487 rests on`,
    );

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

    const bridgedRenderer = throughBridge.busiest.find((row) => row.type === "Tab");
    if (bridgedRenderer) {
      assert(
        bridgedRenderer.hostsPage === true || bridgedRenderer.hostsPage === false,
        `a renderer crossed the bridge with hostsPage=${bridgedRenderer.hostsPage} — the page column cannot be read from that`,
      );
    }
    note(`bridge answered ${throughBridge.totals.processes} processes over ${throughBridge.windowMs}ms`);

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

    at("deciding a runaway notice from real metrics");
    const realMetrics = app.getAppMetrics();

    let previous = new Map();
    let quiet = null;
    for (let poll = 0; poll < 2; poll += 1) {
      quiet = serviceWorkerWatchdog.decideTerminations({
        metrics: app.getAppMetrics(),
        liveProcessIds: liveRendererProcessIds(),
        workers: [],
        previous,
      });
      previous = quiet.hot;
    }
    assert(
      quiet.notices.length === 0,
      `two polls of real metrics on an idle fixture produced ${quiet.notices.length} runaway notice(s) — the surface would cry wolf on every launch`,
    );

    previous = new Map();
    let loud = null;
    for (let poll = 0; poll < 2; poll += 1) {
      loud = serviceWorkerWatchdog.decideTerminations({
        metrics: realMetrics,
        liveProcessIds: [],
        workers: [],
        previous,
        thresholdPercent: 0,
      });
      previous = loud.hot;
    }
    assert(loud.kill.length === 0, "a kill was decided with no candidate origin to name it as");
    const named = loud.notices.find((notice) => notice.pid === rendererPid);
    assert(
      named,
      `the notice path did not name pid ${rendererPid}, which getAppMetrics() reports as a renderer — the surface is not reading real processes`,
    );
    assert(named.killed === false && named.origins.length === 0, "a notice with no candidate origin claimed a kill");

    previous = new Map();
    let joined = null;
    for (let poll = 0; poll < 2; poll += 1) {
      joined = serviceWorkerWatchdog.decideTerminations({
        metrics: realMetrics,
        liveProcessIds: liveRendererProcessIds(),
        workers: [],
        previous,
        thresholdPercent: 0,
      });
      previous = joined.hot;
    }
    assert(
      !joined.notices.some((notice) => notice.pid === rendererPid),
      `pid ${rendererPid} is hosting a page and was still announced as a runaway — the join #487 rests on is not reaching the notice`,
    );
    note(`notice named pid ${named.pid} at ${Math.round(named.percent)}% with the page join off, and not with it on`);

    at("pushing the notice to a real renderer");
    const pushed = { at: Date.now(), renderers: [{ pid: named.pid, percent: named.percent, polls: named.polls, killed: false, origins: [] }] };
    const subscribed = await window.webContents.executeJavaScript(`
      (function () {
        if (!window.telarDesktop || !window.telarDesktop.metrics || !window.telarDesktop.metrics.onRunaway) return "no-bridge";
        window.__telarRunaway = null;
        window.telarDesktop.metrics.onRunaway(function (notice) { window.__telarRunaway = notice; });
        return "subscribed";
      })()
    `);
    assert(subscribed === "subscribed", `preload.js exposed no telarDesktop.metrics.onRunaway to a real renderer (${subscribed})`);
    window.webContents.send("telar:metrics:runaway", pushed);
    let delivered = null;
    for (let attempt = 0; attempt < 40 && delivered === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      delivered = await window.webContents.executeJavaScript("window.__telarRunaway");
    }
    assert(delivered !== null, "the runaway notice never reached a real renderer within four seconds");
    assert(
      Array.isArray(delivered.renderers) && delivered.renderers.length === 1 && delivered.renderers[0].pid === named.pid,
      `the notice crossed the bridge as ${JSON.stringify(delivered)} — the cockpit reads .renderers[].pid`,
    );
    assert(
      delivered.renderers[0].killed === false,
      "`killed` did not survive the structured clone — the cockpit branches on it, and false and undefined are different sentences",
    );

    console.log("PROCESS_METRICS_OK 6/6 orphan=named page=not-named");
  } finally {
    at("tearing down");
    ipcMain.removeHandler("telar:metrics:read");

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
