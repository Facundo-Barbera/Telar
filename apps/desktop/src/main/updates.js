const { BrowserWindow, app, ipcMain } = require("electron");
const updateWatchdog = require("./update-watchdog");
const { autoUpdater, CancellationToken } = require("electron-updater");
const desktopHandoff = require("../handoff/desktop-handoff");
const { writePlannedRestart, createInstallGate, clearPlannedRestart } = require("./update-install");
const path = require("node:path");
const devUpdate = require("../dev/dev-update");
const { DEV_BUILD } = require("./flags");
const { logShell } = require("./shell-log");
const { requireCockpitSender } = require("./browser-hosts");
const { readUpdatePrefs, UPDATE_CHANNELS, updateLogPath, updateProxyKey, writeUpdatePrefs } = require("./update-prefs");

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function updateLogger() {
  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
    try {
      require("node:fs").appendFileSync(updateLogPath(), line);
    } catch {
    }
    console.log(`[telar-updates] ${level} ${message}`);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    debug: () => {},
  };
}

function createUpdater(main) {
  const { telarHome } = main;
  let lastUpdateStatus = null;

  function broadcastUpdateStatus(status, extra = {}) {
    lastUpdateStatus = { status, ...extra };
    const win = main.updaterWindow || BrowserWindow.getAllWindows()[0];
    win?.webContents.send("telar:updates:status", lastUpdateStatus);
  }

  function updatesConfigured() {
    if (DEV_BUILD) return false;
    return app.isPackaged && Boolean(updateProxyKey());
  }

  const downloadWatch = updateWatchdog.createDownloadWatch({
    stallMs: updateWatchdog.STALL_MS,
    onStall: (stalled) => abandonDownload(stalled, "stalled"),
  });

  function discardPendingDownload() {
    try {
      return updateWatchdog.removeStaleTempFiles(updateWatchdog.pendingUpdateDir(autoUpdater));
    } catch {
      return [];
    }
  }

  function abandonDownload(download, reason) {
    if (!download) return;
    try {
      download.token?.cancel();
    } catch {
    }
    const removed = discardPendingDownload();
    const percent = Math.round(download.percent ?? 0);
    const label = download.version ? `v${download.version}` : "the update";
    autoUpdater.logger?.warn?.(
      `download of ${label} ${reason} at ${percent}% — cancelled${removed.length ? `, removed ${removed.join(", ")}` : ""}`,
    );
    if (reason !== "stalled") return;
    broadcastUpdateStatus("error", {
      version: download.version,
      message: `Download stalled at ${percent}% — nothing arrived for ${Math.round(updateWatchdog.STALL_MS / 1000)}s, so it was cancelled. Check again to retry.`,
    });
  }

  function startUpdateDownload(info) {
    if (downloadWatch.inFlight()) return;
    const token = new CancellationToken();
    downloadWatch.begin({ token, version: info?.version });
    autoUpdater.downloadUpdate(token).catch((err) => {
      downloadWatch.settle();
      if (updateWatchdog.isCancellationError(err)) return;
      autoUpdater.logger?.error?.(`download failed: ${err?.message || err}`);
    });
  }

  async function checkForUpdates() {
    const outcome = await updateWatchdog.settleWithin(autoUpdater.checkForUpdates(), updateWatchdog.CHECK_TIMEOUT_MS);
    if (!outcome.timedOut) return outcome.value ?? null;

    updateWatchdog.clearCachedCheckPromise(autoUpdater);
    autoUpdater.logger?.warn?.(`update check did not answer within ${updateWatchdog.CHECK_TIMEOUT_MS / 1000}s — giving up on it`);
    broadcastUpdateStatus("error", {
      message: `Update check timed out after ${Math.round(updateWatchdog.CHECK_TIMEOUT_MS / 1000)}s. Check again to retry.`,
    });
    return null;
  }

  function applyUpdatePrefs(prefs) {
    autoUpdater.channel = prefs.channel;

    autoUpdater.autoInstallOnAppQuit = prefs.installOnQuit;
  }

  function configureAutoUpdater() {
    autoUpdater.logger = updateLogger();

    autoUpdater.autoDownload = false;
    applyUpdatePrefs(readUpdatePrefs());
    const key = updateProxyKey();
    if (key) autoUpdater.requestHeaders = { "X-Telar-Update-Key": key };

    autoUpdater.on("checking-for-update", () => broadcastUpdateStatus("checking"));
    autoUpdater.on("update-available", (info) => {
      broadcastUpdateStatus("available", { version: info.version });
      startUpdateDownload(info);
    });
    autoUpdater.on("update-not-available", (info) => broadcastUpdateStatus("not-available", { version: info.version }));
    autoUpdater.on("download-progress", (progress) => {
      const live = downloadWatch.progress(progress.percent);
      broadcastUpdateStatus("downloading", { percent: progress.percent, version: live?.version ?? undefined });
    });
    autoUpdater.on("update-downloaded", (info) => {
      downloadWatch.settle();
      broadcastUpdateStatus("downloaded", { version: info.version });
    });
    autoUpdater.on("error", (err) => {
      downloadWatch.settle();

      if (updateWatchdog.isCancellationError(err)) return;
      broadcastUpdateStatus("error", { message: err && err.message ? err.message : String(err) });
    });

    if (!updatesConfigured()) return;
    void checkForUpdates();
    const timer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
    timer.unref?.();

    desktopHandoff.start({
      channel: () => readUpdatePrefs().channel,
      key: updateProxyKey(),
      quit: quitForHandoff,
      log: autoUpdater.logger,
    });
  }

  async function quitForHandoff() {
    app.isQuitting = true;
    writePlannedRestart(path.join(telarHome(), "engine"));
    if (main.terminalHost && main.terminalHost.size > 0) {
      try {
        await main.terminalHost.closeAll();
        await main.terminalHost.drain();
      } catch (error) {
        logShell("error", `closing terminals before the hand-off failed: ${error?.stack || error}`);
      }
    }
    main.terminalsClosedForQuit = true;
    app.quit();
  }

  return {
    abandonDownload,
    applyUpdatePrefs,
    broadcastUpdateStatus,
    checkForUpdates,
    configureAutoUpdater,
    downloadWatch,
    lastStatus: () => lastUpdateStatus,
    updatesConfigured,
  };
}

function registerUpdates(main) {
  const { telarHome } = main;
  const updater = createUpdater(main);
  const { abandonDownload, applyUpdatePrefs, broadcastUpdateStatus, checkForUpdates, configureAutoUpdater, downloadWatch, updatesConfigured } = updater;

  ipcMain.handle("telar:updates:check", async () => {
    if (!updatesConfigured()) return { status: "unsupported" };
    const plan = downloadWatch.plan();
    if (plan === "report") {
      const live = downloadWatch.inFlight();
      broadcastUpdateStatus("downloading", { percent: live.percent, version: live.version });
      return { status: "downloading", version: live.version, percent: live.percent };
    }

    if (plan === "restart") abandonDownload(downloadWatch.settle(), "went quiet while the machine slept");
    await checkForUpdates();
    return { status: "checking" };
  });

  const installGate = createInstallGate();

  ipcMain.handle("telar:updates:install", async () => {
    const decision = installGate.press({ packaged: app.isPackaged, devBuild: DEV_BUILD });
    if (decision === "unsupported") return { status: "unsupported" };

    broadcastUpdateStatus("restarting", { version: updater.lastStatus()?.version });

    if (decision === "pending") return { status: "restarting" };

    autoUpdater.autoInstallOnAppQuit = false;
    app.isQuitting = true;

    const engineRoot = path.join(telarHome(), "engine");
    writePlannedRestart(engineRoot);

    if (main.terminalHost && main.terminalHost.size > 0) {
      try {
        await main.terminalHost.closeAll();
        await main.terminalHost.drain();
      } catch (error) {
        logShell("error", `closing terminals before the update restart failed: ${error?.stack || error}`);
      }
    }
    main.terminalsClosedForQuit = true;
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      installGate.reset();
      app.isQuitting = false;
      main.terminalsClosedForQuit = false;

      clearPlannedRestart(engineRoot);
      const message = err && err.message ? err.message : String(err);
      autoUpdater.logger?.error?.(`quitAndInstall failed: ${message}`);
      broadcastUpdateStatus("error", { version: updater.lastStatus()?.version, message });
      return { status: "error", message };
    }
    return { status: "restarting" };
  });

  ipcMain.handle("telar:updates:status", () => updater.lastStatus());

  ipcMain.handle("telar:updates:busy", async (event) => {
    requireCockpitSender(event, "ask what a restart would end");
    if (!main.terminalHost || main.terminalHost.size === 0) return { terminals: { count: 0, commands: [] } };
    const { busyTerminals } = require("../terminal/terminal-host");
    return { terminals: busyTerminals(await main.terminalHost.activeProcesses()) };
  });

  ipcMain.handle("telar:updates:openLocalUpdater", () => {
    if (!DEV_BUILD) return { ok: false, error: "This build updates from its published channel, not a local checkout." };
    devUpdate.openWindow();
    return { ok: true };
  });

  ipcMain.handle("telar:updates:getPrefs", () => ({
    ...readUpdatePrefs(),
    channels: UPDATE_CHANNELS,

    logPath: updateLogPath(),

    configured: updatesConfigured(),

    localUpdater: DEV_BUILD,
  }));

  ipcMain.handle("telar:updates:setPrefs", (_event, patch) => {
    const current = readUpdatePrefs();
    const next = {
      channel:
        typeof patch?.channel === "string" && UPDATE_CHANNELS.includes(patch.channel)
          ? patch.channel
          : current.channel,
      installOnQuit: typeof patch?.installOnQuit === "boolean" ? patch.installOnQuit : current.installOnQuit,
    };
    writeUpdatePrefs(next);
    applyUpdatePrefs(next);

    if (next.channel !== current.channel && updatesConfigured()) void checkForUpdates();
    return next;
  });

  return { configureAutoUpdater };
}

module.exports = { registerUpdates };
