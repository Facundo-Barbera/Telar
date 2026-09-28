const { app, BrowserWindow, powerMonitor } = require("electron");
const { ACTIVE_IDLE_SECONDS, createPresenceReporter, routeOf } = require("./desktop-notifications");
const { browserManagers } = require("./browser-hosts");

function cockpitFocus() {
  const focused = BrowserWindow.getFocusedWindow();
  const cockpit = focused && [...browserManagers].some((manager) => manager.window === focused);
  return { focused: Boolean(cockpit), viewingPath: cockpit ? routeOf(focused.webContents.getURL()) : null };
}

function createPresence({ send }) {
  let screenLocked = false;
  let watched = false;
  const reporter = createPresenceReporter({
    sample: () => ({ idleState: powerMonitor.getSystemIdleState(ACTIVE_IDLE_SECONDS), locked: screenLocked, ...cockpitFocus() }),
    send,
  });
  const report = () => reporter.report();
  return {
    report,
    stop: () => reporter.stop(),
    watch() {
      if (!watched) {
        watched = true;
        powerMonitor.on("lock-screen", () => { screenLocked = true; report(); });
        powerMonitor.on("unlock-screen", () => { screenLocked = false; report(); });
        app.on("browser-window-focus", report);
        app.on("browser-window-blur", report);
      }
      reporter.start();
    },
  };
}

module.exports = { cockpitFocus, createPresence };
