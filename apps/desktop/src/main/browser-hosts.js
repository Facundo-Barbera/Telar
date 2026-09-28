const browserManagers = new Set();
let current = null;
let lastWindowUrl = null;

function addHost(win, manager) {
  browserManagers.add(manager);
  current = manager;
  win.on("focus", () => {
    current = manager;
  });
}

function removeHost(manager) {
  browserManagers.delete(manager);
  if (current === manager) current = browserManagers.values().next().value ?? null;
}

function currentHost() {
  return current;
}

function managerForEvent(event) {
  const sender = event?.sender;
  if (!sender) return null;
  for (const manager of browserManagers) {
    if (!manager.window.isDestroyed() && manager.window.webContents === sender) return manager;
  }
  return null;
}

function requireBrowserManager(event) {
  const manager = managerForEvent(event) || current;
  if (!manager) throw new Error("The Telar desktop browser host is not ready.");
  return manager;
}

function requireCockpitSender(event, what) {
  const manager = requireBrowserManager(event);
  const cockpit = manager.window;
  if (!cockpit || cockpit.isDestroyed() || event.sender !== cockpit.webContents || event.senderFrame !== cockpit.webContents.mainFrame) {
    throw new Error(`Only the Telar window may ${what}.`);
  }
  return manager;
}

function persistAllHosts() {
  for (const manager of browserManagers) { try { manager.persistSync(); } catch {} }
}

module.exports = {
  addHost,
  browserManagers,
  currentHost,
  lastWindowUrl: () => lastWindowUrl,
  persistAllHosts,
  rememberWindowUrl: (url) => { lastWindowUrl = url; },
  removeHost,
  requireBrowserManager,
  requireCockpitSender,
};
