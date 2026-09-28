const { app, BrowserWindow, session, webContents } = require("electron");
const serviceWorkerWatchdog = require("./service-worker-watchdog");
const { createProcessMetricsReader } = require("./process-metrics");
const { logShell } = require("./shell-log");

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

let processMetrics = null;
function processMetricsReader() {
  if (!processMetrics) {
    processMetrics = createProcessMetricsReader({
      readMetrics: () => app.getAppMetrics(),
      readLiveProcessIds: liveRendererProcessIds,
    });
  }
  return processMetrics;
}

let lastRunawayNotice = { at: 0, renderers: [] };
function broadcastRunawayNotice(notices) {
  lastRunawayNotice = {
    at: Date.now(),

    renderers: (notices || []).map((notice) => ({
      pid: notice.pid,
      percent: notice.percent,
      polls: notice.polls,
      killed: Boolean(notice.killed),
      origins: notice.origins || [],
    })),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("telar:metrics:runaway", lastRunawayNotice);
    } catch {
    }
  }
}

function readWorkers(browserManagers) {
  const workers = [];
  const partitions = new Set();
  const liveOrigins = new Map();
  for (const manager of browserManagers) {
    for (const partition of manager.activePartitions()) partitions.add(partition);
    for (const [partition, origins] of manager.liveOriginsByPartition()) {
      if (!liveOrigins.has(partition)) liveOrigins.set(partition, new Set());
      for (const origin of origins) liveOrigins.get(partition).add(origin);
    }
  }
  for (const partition of partitions) {
    let running;
    try {
      running = session.fromPartition(partition).serviceWorkers.getAllRunning();
    } catch {
      continue;
    }
    for (const info of Object.values(running || {})) {
      const origin = serviceWorkerWatchdog.originOfScope(info?.scope);
      workers.push({
        partition,
        scope: info?.scope,
        scriptUrl: info?.scriptUrl,
        versionId: info?.versionId,
        hasLiveTab: Boolean(origin && liveOrigins.get(partition)?.has(origin)),
      });
    }
  }
  return workers;
}

function startServiceWorkerWatchdog(browserManagers) {
  const watchdog = serviceWorkerWatchdog.createServiceWorkerWatchdog({
    readMetrics: () => processMetricsReader().metricsForWatchdog({ minWindowMs: 25_000 }),
    readLiveProcessIds: liveRendererProcessIds,
    readWorkers: () => readWorkers(browserManagers),
    terminate: (pid) => process.kill(pid, "SIGKILL"),
    log: logShell,
    onNotice: broadcastRunawayNotice,
  });
  watchdog.start();
  return watchdog;
}

module.exports = { lastRunawayNotice: () => lastRunawayNotice, processMetricsReader, startServiceWorkerWatchdog };
