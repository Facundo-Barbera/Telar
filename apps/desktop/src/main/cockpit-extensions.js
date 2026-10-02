const { app, session } = require("electron");
const { ExtensionHost, extensionsEnabled } = require("../browser/extension-host");
const { passwordManagerEnabled } = require("../login/password-manager-prefs");
const { DEV_BUILD, SMOKE } = require("./flags");

function extensionTabs(win, manager, partition, host) {
  return {
    createTab: async (details) => {
      const url = details.url || "about:blank";
      if (url.startsWith('chrome-extension:')) {
        const page = host().openExtensionPage(url, win);
        return [page.webContents, page];
      }

      const onPartition = (scope) => { try { return manager.partitionOf(scope) === partition; } catch { return false; } };
      const scope = (manager.visibleScopeKey && onPartition(manager.visibleScopeKey))
        ? manager.visibleScopeKey
        : [...new Set(manager.tabs.map((t) => t.scopeKey))].find(onPartition);
      if (!scope) throw new Error("No browser session for this profile is open to receive a tab.");
      const tab = await manager.createTab(scope, url, "human");
      return [tab.view.webContents, win];
    },
    selectTab: (wc) => {
      const tab = manager.tabs.find((t) => t.view && t.view.webContents === wc);
      if (tab) manager.selectTab(tab.scopeKey, manager.scopeTabs(tab.scopeKey).indexOf(tab)).catch(() => undefined);
    },
    removeTab: (wc) => {
      const tab = manager.tabs.find((t) => t.view && t.view.webContents === wc);
      if (tab) { manager.closeTabRef(tab); return; }
      for (const page of host().extensionWindows) if (!page.isDestroyed() && page.webContents === wc) page.close();
    },
  };
}

function startExtensionHost(win, manager, partition, enabled = passwordManagerEnabled) {
  const wanted = extensionsEnabled({ dev: DEV_BUILD, packaged: app.isPackaged, version: app.getVersion(), override: process.env.TELAR_EXTENSIONS });
  if (!wanted || SMOKE || !enabled()) return null;
  const ses = session.fromPartition(partition);
  const host = new ExtensionHost(ses, { window: win, tabs: extensionTabs(win, manager, partition, () => host) });
  host.onHealthChange = (status) => { if (!win.isDestroyed() && enabled()) win.webContents.send("telar:browser:extension", { partition, ...status }); };

  host.onHoldOpen = (id, reason) => manager.addUiHold(id, reason);
  host.onHoldClose = (id) => manager.removeUiHold(id);
  host.startOnce().then((status) => {
    if (status.phase === "failed") console.error(`[telar-desktop] 1Password extension (${partition}): ${status.error}`);
    if (!win.isDestroyed() && enabled()) win.webContents.send("telar:browser:extension", { partition, ...status });
  });
  return host;
}

module.exports = { startExtensionHost };
