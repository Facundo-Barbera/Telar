const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function shellLogPath() {
  return path.join(app.getPath("userData"), "shell.log");
}

function logShell(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
  try {
    fs.appendFileSync(shellLogPath(), line);
  } catch {
  }
  console.log(`[telar-shell] ${level} ${message}`);
}

function watchForUnpairing(webContents) {
  const originOf = (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return "an unparseable URL";
    }
  };
  webContents.on("did-navigate", (_event, url, httpResponseCode) => {
    if (httpResponseCode === 401) logShell("warn", `the host window was refused (401) by ${originOf(url)}`);
  });
  webContents.on("did-redirect-navigation", (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.pathname === "/pair" || parsed.pathname.startsWith("/pair/")) {
      logShell("warn", `the host window was sent to the pairing page by ${parsed.origin}`);
    }
  });
}

const HEAP_LOG_INTERVAL_MS = 60_000;
const HEAP_WARN_BYTES = 1_024 * 1_024 * 1_024;

function heapLogRequested() {
  return process.argv.includes("--telar-heap-log") || process.env.TELAR_SHELL_HEAP_LOG === "1";
}

function diagnosticsDir() {
  return path.join(app.getPath("userData"), "diagnostics");
}

const mb = (bytes) => Math.round(Number(bytes || 0) / (1024 * 1024));

let heapWarned = false;
let heapSnapshotWritten = false;

function writeHeapSnapshotOnce() {
  if (heapSnapshotWritten) return null;
  heapSnapshotWritten = true;
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true });
    const file = path.join(diagnosticsDir(), `main-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`);
    require("node:v8").writeHeapSnapshot(file);
    return file;
  } catch (error) {
    logShell("warn", `could not write a heap snapshot: ${error && error.message ? error.message : error}`);
    return null;
  }
}

async function heapLogTick(detailed, readViews) {
  const heap = require("node:v8").getHeapStatistics();
  if (detailed) {
    const memory = process.memoryUsage();

    let footprint = null;
    try {
      footprint = typeof process.getProcessMemoryInfo === "function" ? await process.getProcessMemoryInfo() : null;
    } catch {
    }
    const views = readViews();
    logShell(
      "info",
      [
        `heap rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB heapTotal=${mb(memory.heapTotal)}MB`,
        `external=${mb(memory.external)}MB arrayBuffers=${mb(memory.arrayBuffers)}MB`,
        `usedHeapSize=${mb(heap.used_heap_size)}MB heapLimit=${mb(heap.heap_size_limit)}MB`,
        footprint ? `private=${Math.round(Number(footprint.private || 0) / 1024)}MB residentSet=${Math.round(Number(footprint.residentSet || 0) / 1024)}MB` : "private=?",
        `windows=${BrowserWindow.getAllWindows().length}`,
        views
          ? `scopes=${views.scopes} tabs=${views.tabs} liveViews=${views.liveViews} wcListeners=${views.wcListeners} extensionHosts=${views.extensionHosts} console=${views.consoleEntries} network=${views.networkEntries} expectedReports=${views.expectedReports} refs=${views.refs} scopeEntries=${views.scopeEntries} pendingPopups=${views.pendingPopups} uiHolds=${views.uiHolds}`
          : "manager=none",
      ].join(" "),
    );
  }
  if (heap.used_heap_size < HEAP_WARN_BYTES || heapWarned) return;
  heapWarned = true;
  const snapshot = detailed ? writeHeapSnapshotOnce() : null;
  logShell(
    "warn",
    `the main process V8 heap passed ${mb(HEAP_WARN_BYTES)}MB (used=${mb(heap.used_heap_size)}MB of a ${mb(heap.heap_size_limit)}MB limit) — see issue #296. This warns once per launch.` +
      (snapshot ? ` Heap snapshot: ${snapshot}` : heapLogRequested() ? "" : " Relaunch with TELAR_SHELL_HEAP_LOG=1 for a per-minute series and a heap snapshot."),
  );
}

function startHeapLog(readViews) {
  const detailed = heapLogRequested();
  if (detailed) void heapLogTick(true, readViews);
  const timer = setInterval(() => void heapLogTick(detailed, readViews), HEAP_LOG_INTERVAL_MS);

  timer.unref?.();
}

module.exports = { logShell, shellLogPath, startHeapLog, watchForUnpairing };
