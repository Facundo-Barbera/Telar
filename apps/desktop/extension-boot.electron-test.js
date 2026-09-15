/**
 * ZERO-TAB BOOT HARNESS — the app's real startup order, which the compat
 * harness did not reproduce: window up, extension loaded with NO tabs
 * tracked, then the toolbar popup opened for a tab created afterwards.
 *
 * Reports (no payloads, no vault): the worker's error lines during boot,
 * whether `browser.runtime.connectNative` is the library's (native-host
 * spawning) or Electron's native stub, whether the popup window became
 * visible and its size, and whether a 1Password-BrowserSupport child of
 * THIS process appeared (signature acceptance is a separate question).
 *
 *   TELAR_1P_CRX=<cached crx> [TELAR_BOOT_REGISTER_WINDOW=0] \
 *     env -u ELECTRON_RUN_AS_NODE electron ./extension-boot.electron-test.js
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");
const { ONE_PASSWORD } = require("./extension-host");

const PARTITION = "persist:telar-boot-harness";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KNOWN_NOISE = /No source for require\(webRequest|deprecated parameters for the initialization function/;

async function main() {
  const crx = process.env.TELAR_1P_CRX;
  if (!crx || !fs.existsSync(crx)) throw new Error("TELAR_1P_CRX must point at the cached official package");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "telar-1password-boot-"));
  const registerWindow = process.env.TELAR_BOOT_REGISTER_WINDOW !== "0";
  const report = { registerWindow, workerErrors: [], popup: null, alias: null, nativeChild: null };
  const t0 = Date.now();
  const note = (line) => console.log(`BOOT ${line}`);

  // Observe the native host's LIFECYCLE only (path basename, exit code) —
  // never its stdio. The library looks spawn up on the module at call time.
  const cp = require("node:child_process");
  const realSpawn = cp.spawn;
  report.nativeSpawns = [];
  cp.spawn = function (file, args, opts) {
    const child = realSpawn.call(this, file, args, opts);
    if (/BrowserSupport/.test(String(file))) {
      const entry = { host: path.basename(String(file)), origin: String((args || [])[0] || "").replace(/^chrome-extension:\/\/[a-p]{32}/, "ext:"), at: Date.now() - t0, exit: null, signal: null, error: null };
      report.nativeSpawns.push(entry);
      child.on("exit", (code, signal) => { entry.exit = code; entry.signal = signal; entry.livedMs = Date.now() - t0 - entry.at; });
      child.on("error", (error) => { entry.error = error.code || String(error.message).slice(0, 80); });
    }
    return child;
  };
  const unpacked = path.join(work, "ext");
  unpackVerified(crx, unpacked, ONE_PASSWORD.id);
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  registerShimPreload(ses, work, [ONE_PASSWORD.id]);
  const hostTabs = [];
  // The product's route for the extension's own pages (main.js createTab →
  // ExtensionHost.openExtensionPage): a human-only window, not a tab.
  const { ExtensionHost } = require("./extension-host");
  const pageHost = Object.assign(Object.create(ExtensionHost.prototype), { session: ses, extensionWindows: new Set() });
  const extensions = attachExtensionSupport(ses, {
    createTab: async (details) => {
      if (/^chrome-extension:/.test(details.url || "")) {
        const page = pageHost.openExtensionPage(details.url, window);
        return [page.webContents, page];
      }
      const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.contentView.addChildView(view);
      hostTabs.push(view);
      extensions.addTab(view.webContents, window);
      if (details.url) view.webContents.loadURL(details.url).catch(() => undefined);
      return [view.webContents, window];
    },
    selectTab: () => undefined,
    removeTab: (wc) => { try { wc.close(); } catch {} },
  }, { preloadDir: work, ...(registerWindow ? { window } : {}) });

  ses.serviceWorkers.on("console-message", (_event, details) => {
    if (details.level >= 2 && !KNOWN_NOISE.test(details.message)) report.workerErrors.push(String(details.message).slice(0, 160));
  });
  const extension = await ses.extensions.loadExtension(unpacked, { allowFileAccess: false });
  note(`loaded ${extension.id} ${extension.version} with ${hostTabs.length} tabs tracked, window registered=${registerWindow}`);
  await sleep(8000);
  note(`worker errors during 8 s boot: ${JSON.stringify(report.workerErrors)}`);

  // Now a tab appears (the user opens the fixture) and the key is clicked.
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  extensions.addTab(view.webContents, window);
  await view.webContents.loadURL("data:text/html,<title>Fixture</title><input type=password>");
  extensions.selectTab(view.webContents);
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
  const action = extensions.api.browserAction.getAction(extension.id);
  const tabsCreatedBefore = hostTabs.length;
  report.actionState = { popup: action.popup, tabPopup: action.tabs?.[view.webContents.id]?.popup, title: action.title, resolvedUrl: (extensions.api.browserAction.getPopupUrl(extension.id, view.webContents.id) || "").replace(/^chrome-extension:\/\/[a-p]{32}/, "ext:") };
  note(`action state before click: ${JSON.stringify(report.actionState)}`);
  await extensions.api.browserAction.activate(
    { type: "frame", sender: null, extension },
    { eventType: "click", extensionId: extension.id, tabId: view.webContents.id, anchorRect: { x: 900, y: 10, width: 28, height: 28 }, alignment: "right" },
  );
  await sleep(5000);
  const popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
  if (popup && !popup.isDestroyed()) {
    const b = popup.getBounds();
    report.popup = { exists: true, visible: popup.isVisible(), width: b.width, height: b.height, title: popup.webContents.getTitle(), url: popup.webContents.getURL().replace(/^chrome-extension:\/\/[a-p]{32}/, "ext:") };
    try {
      report.alias = await popup.webContents.executeJavaScript(`({
        browserIsChrome: globalThis.browser === globalThis.chrome,
        connectNativeShared: globalThis.browser?.runtime?.connectNative === globalThis.chrome?.runtime?.connectNative,
        libraryRuntime: typeof chrome.runtime.connectNative === "function" && String(chrome.runtime.connectNative).includes("NativePort"),
        bodyText: (document.body?.innerText || "").trim().length,
        bodyHeight: document.body ? document.body.scrollHeight : -1,
      })`, true);
    } catch (error) { report.alias = { error: String(error.message) }; }
  } else {
    report.popup = { exists: Boolean(popup), destroyed: popup ? popup.isDestroyed() : null };
  }
  const pages = [...pageHost.extensionWindows].filter((w) => !w.isDestroyed());
  const pageInfo = [];
  for (const w of pages) {
    let text = -1;
    try { text = await w.webContents.executeJavaScript("(document.body?.innerText || '').trim().length", true); } catch {}
    pageInfo.push({ visible: w.isVisible(), size: w.getSize(), url: w.webContents.getURL().replace(/^chrome-extension:\/\/[a-p]{32}/, "ext:").slice(0, 100), title: w.webContents.getTitle(), textChars: text });
  }
  report.afterClick = { tabsCreated: hostTabs.length - tabsCreatedBefore, extensionWindows: pageInfo };
  note(`after click: ${JSON.stringify(report.afterClick)}`);
  note(`popup: ${JSON.stringify(report.popup)}`);
  note(`alias: ${JSON.stringify(report.alias)}`);
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
    const mine = ps.split("\n").filter((l) => /1Password-BrowserSupport/.test(l)).map((l) => l.trim().split(/\s+/)).filter(([, ppid]) => Number(ppid) === process.pid);
    report.nativeChild = mine.length ? `alive (pid ${mine[0][0]})` : "none";
  } catch { report.nativeChild = "unknown"; }
  note(`native host child of this process: ${report.nativeChild}`);
  note(`native host spawns: ${JSON.stringify(report.nativeSpawns)}`);
  note(`worker errors total: ${JSON.stringify([...new Set(report.workerErrors)])}`);
  note(`elapsed ${Date.now() - t0} ms`);
  fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
  console.log(`BOOT report ${path.join(work, "report.json")}`);
  window.destroy();
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("BOOT_FAIL", error); app.exit(1); });
