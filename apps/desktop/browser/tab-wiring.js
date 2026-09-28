const { HUMAN_ATTRIBUTION_GRACE_MS, MAX_TABS_PER_SCOPE, navigationFlag } = require("./shared");
const { SEARCH_URL, VIEW_SOURCE_PREFIX, normalizePopupUrl } = require("./urls");
const { browserContextMenuTemplate } = require("../browser-context-menu");

module.exports = {
  popupOpener(tab) {
    const recentAgentInput = this.now() - (this.lastAgentInputAt.get(tab.scopeKey) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
    return tab.agentBusy > 0 || recentAgentInput ? "agent" : "human";
  },

  trackPopupTab(task) {
    this.pendingPopupTabs.add(task);
    task.then(
      () => this.pendingPopupTabs.delete(task),
      () => this.pendingPopupTabs.delete(task),
    );
    return task;
  },

  async settlePopupTabs() {
    await Promise.allSettled([...this.pendingPopupTabs]);
  },

  decidePopup(opener, details) {
    if (!normalizePopupUrl(details?.url)) return { action: "deny" };
    if (!this.tabs.includes(opener)) return { action: "deny" };
    if (this.scopeTabs(opener.scopeKey).length >= MAX_TABS_PER_SCOPE) return { action: "deny" };

    const openedBy = this.popupOpener(opener);
    return {
      action: "allow",

      outlivesOpener: true,
      createWindow: (options) => this.adoptPopupTab(opener, options, openedBy),
    };
  },

  adoptPopupTab(opener, options, openedBy) {
    const guest = options?.webContents || null;

    const expected = this.sessionFor(opener.partition);
    if (guest && expected && guest.session && guest.session !== expected) {
      queueMicrotask(() => { try { guest.close(); } catch {  } });
      return guest;
    }
    const scope = opener.scopeKey;

    const tab = this.newTabRecord(scope, { partition: opener.partition, id: opener.profileId }, openedBy);
    const wasEmpty = this.scopeTabs(scope).length === 0;
    this.tabs.push(tab);

    if (openedBy === "human" || wasEmpty) this.activeTabIds.set(scope, tab.id);
    if (openedBy === "agent") {
      this.agentTabIds.set(scope, tab.id);
      this.agentTabClosed.delete(scope);
    }
    const view = this.adoptViewForTab(tab, guest);

    if (openedBy === "human") tab.lastHumanInputAt = this.now();
    this.journalControl(tab, openedBy === "human" ? "human" : "agent");
    this.applyVisibility();
    this.emitState(scope);
    this.trackPopupTab(this.finishPopupTab(tab, view));
    return view.webContents;
  },

  async finishPopupTab(tab, view) {
    const scope = tab.scopeKey;
    const humanTabBefore = this.activeTabIds.get(scope);
    await this.readyHostForTab(tab, view);

    if (
      tab.openedBy === "agent" &&
      humanTabBefore !== undefined &&
      this.activeTabIds.get(scope) !== humanTabBefore &&
      this.tabs.some((candidate) => candidate.id === humanTabBefore)
    ) {
      this.activeTabIds.set(scope, humanTabBefore);
    }
    this.enforceLiveViewBudget(tab);
    this.applyVisibility();
    this.emitState(scope);
    return tab;
  },

  newTabRecord(scope, profile, openedBy) {
    return {
      id: this.createId(),
      scopeKey: scope,

      partition: profile.partition,
      profileId: profile.id,
      view: null,

      viewport: undefined,

      viewportMode: "fit",

      zoom: 1,

      colorScheme: "system",

      colorSchemeApplied: undefined,

      documentReady: false,

      canvas: undefined,

      previewWindow: null,

      geometry: null,

      restored: false,
      title: "New tab",
      url: "about:blank",
      loading: false,
      openedBy,

      lastHumanInputAt: undefined,
      generation: 0,
      observedGeneration: -1,
      staleReason: "",
      agentBusy: 0,

      expectedReports: [],

      interruptedAt: undefined,
      ticket: 0,
      queue: Promise.resolve(),
      lastJournaled: "idle",
      faviconUrl: null,
      refs: new Map(),
      console: [],
      network: [],
      debuggerReady: false,
      debuggerListenersBound: false,
      hibernating: false,
      hibernateWhenIdle: false,
      destroyWhenIdle: false,
      hibernateTimer: null,
      navigationPending: 0,
      lastUsedAt: Date.now(),
    };
  },

  bindTab(tab) {
    const view = tab.view;
    const wc = view.webContents;
    const sync = () => {
      tab.url = wc.getURL() || "about:blank";
      tab.title = wc.getTitle() || (tab.url === "about:blank" ? "New tab" : tab.url);

      const blank = this.isBlank(tab);

      if (blank) tab.documentReady = false;
      if (blank !== tab.wasBlank) { tab.wasBlank = blank; this.applyGeometry(tab).catch(() => {}); }
      this.emitState(tab.scopeKey);
    };
    if (typeof wc.setWindowOpenHandler === "function") {
      wc.setWindowOpenHandler((details) => this.decidePopup(tab, details || {}));
    }

    wc.on("focus", () => this.noteTabKeyFocus(tab, true));
    wc.on("blur", () => this.noteTabKeyFocus(tab, false));

    wc.on("before-input-event", (event, input) => this.handleTabKey(tab, event, input));

    wc.on("did-start-navigation", (details) => {
      if (!details?.isMainFrame || details.isSameDocument || !tab.viewportOverride || !tab.debuggerReady) return;
      tab.viewportOverride = undefined;
      wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    });
    wc.on("dom-ready", () => {
      if (wc.isDestroyed()) return;
      wc.setBackgroundThrottling(false);

      const url = wc.getURL();
      tab.documentReady = Boolean(url) && url !== "about:blank";

      this.ensureViewport(tab).catch(() => {});
    });
    wc.on("did-start-loading", () => {
      tab.loading = true;
      tab.refs.clear();
      sync();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;

      const url = wc.getURL();
      if (url && url !== "about:blank" && !tab.documentReady) {
        tab.documentReady = true;
        this.applyGeometry(tab).catch(() => {});
      }
      sync();
      this.finishDeferredHibernate(tab);
    });
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.emitState(tab.scopeKey);
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      tab.faviconUrl = (Array.isArray(favicons) && favicons[0]) || null;
      this.emitState(tab.scopeKey);
    });
    wc.on("did-navigate", (_event, navigatedUrl, httpResponseCode) => {
      this.noteNavigation(tab);
      sync();
      this.noteVisited(tab, navigatedUrl || wc.getURL(), httpResponseCode);
    });
    wc.on("did-navigate-in-page", sync);

    wc.on("context-menu", (_event, params) => {
      this.noteHumanInput(tab.scopeKey, { force: true });
      this.openContextMenu(tab, params || {});
    });

    wc.on("devtools-opened", () => this.devToolsEdge(tab));
    wc.on("devtools-closed", () => this.devToolsEdge(tab));

    wc.on("render-process-gone", () => {
      this.forgetEmulation(tab);
      tab.documentReady = false;
      this.applyGeometry(tab).catch(() => {});
    });
    wc.on("destroyed", () => {
      if (tab.hibernating || tab.view !== view) return;
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);

      tab.view = null;
      { const host = this.hostOfTab(tab); if (host) { try { host.removeTab(wc); } catch {  } } }
      try { this.window.contentView.removeChildView(view); } catch {  }
      this.noteAgentTabClosed(tab);
      const scoped = this.scopeTabs(tab.scopeKey);
      if (this.activeTabIds.get(tab.scopeKey) === tab.id) {
        this.activeTabIds.set(tab.scopeKey, scoped.at(-1)?.id ?? null);
      }
      this.applyVisibility();
      this.emitState(tab.scopeKey);
    });
  },

  contentsOf(tab) {
    const wc = tab?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  },

  devToolsOpen(tab) {
    const wc = this.contentsOf(tab);
    try {
      return Boolean(wc && wc.isDevToolsOpened && wc.isDevToolsOpened());
    } catch {
      return false;
    }
  },

  openDevTools(tab, inspectAt) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    try {
      if (!this.devToolsOpen(tab)) wc.openDevTools?.({ mode: "detach" });
      if (inspectAt) wc.inspectElement?.(Math.round(inspectAt.x || 0), Math.round(inspectAt.y || 0));
    } catch {
    }
  },

  closeDevTools(tab) {
    if (!this.devToolsOpen(tab)) return;
    try {
      this.contentsOf(tab)?.closeDevTools?.();
    } catch {
    }
  },

  async toggleDevTools(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const activeId = this.activeTabIds.get(scope);
    const tab = this.scopeTabs(scope).find((candidate) => candidate.id === activeId);
    if (!tab) return this.state(scope);
    await this.wakeTab(tab);
    if (this.devToolsOpen(tab)) this.closeDevTools(tab);
    else this.openDevTools(tab);
    this.emitState(scope);
    return this.state(scope);
  },

  async openPreview(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    await this.wakeTab(tab);
    if (this.previewing(tab)) {
      try { tab.previewWindow.focus(); } catch {  }
      return this.state(scope);
    }
    const { BrowserWindow } = this.electron();
    if (!BrowserWindow) throw new Error("This build cannot open a separate window for a tab.");
    const viewport = this.viewportOf(tab);
    const win = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      title: tab.title || "Preview",
      backgroundColor: "#00000000",
      show: true,
    });
    try {
      this.window.contentView.removeChildView(tab.view);
      win.contentView.addChildView(tab.view);
    } catch (error) {
      try { this.window.contentView.addChildView(tab.view); } catch {  }
      try { win.destroy(); } catch {  }
      throw new Error(`Could not open a separate window for this tab: ${error instanceof Error ? error.message : String(error)}`);
    }
    tab.previewWindow = win;
    win.on?.("resize", () => { this.applyGeometry(tab).catch(() => {}); });

    win.on?.("closed", () => {
      if (!tab.previewWindow) return;
      tab.previewWindow = null;
      this.reclaimView(tab);
      this.applyVisibility();
      try { this.emitState(tab.scopeKey); } catch {  }
    });
    this.applyVisibility();
    this.emitState(scope);
    return this.state(scope);
  },

  endPreview(tab) {
    const win = tab?.previewWindow;
    if (!win) return;
    tab.previewWindow = null;
    this.reclaimView(tab);
    try { if (!win.isDestroyed?.()) win.destroy(); } catch {  }
  },

  reclaimView(tab) {
    if (!tab.view) return;
    try { this.window.contentView.addChildView(tab.view); } catch {  }
  },

  closePreview(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    this.endPreview(tab);
    this.applyVisibility();
    this.emitState(scope);
    return this.state(scope);
  },

  async clearBrowsingData(scopeKey, kind) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    if (!tabs.length) throw new Error("There is no tab here to clear anything for.");
    const tab = this.activeTab(scope);
    const ses = this.sessionFor(tab.partition);
    if (!ses) throw new Error("This browser profile has no Chromium session to clear.");
    if (kind === "cookies") await ses.clearStorageData({ storages: ["cookies"] });
    else if (kind === "cache") await ses.clearCache();
    else throw new Error(`Unknown browsing data ${JSON.stringify(kind)}. Use cookies or cache.`);
    return { ok: true, kind, partition: tab.partition, profile: this.profiles.get(tab.profileId)?.label ?? null };
  },

  openContextMenu(tab, params) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    const template = browserContextMenuTemplate(params, {
      canGoBack: navigationFlag(wc, "canGoBack"),
      canGoForward: navigationFlag(wc, "canGoForward"),
    });
    const items = template.map((entry) =>
      entry.type === "separator"
        ? { type: "separator" }
        : {
            label: entry.label,
            enabled: entry.enabled,
            click: () => {
              void Promise.resolve(this.runContextMenuCommand(tab, entry, params)).catch(() => {});
            },
          },
    );
    try {
      const { Menu } = this.electron();
      Menu.buildFromTemplate(items).popup({ window: this.window });
    } catch {
    }
  },

  async runContextMenuCommand(tab, entry, params) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    const scope = tab.scopeKey;
    switch (entry.id) {
      case "open-link-new-tab":
      case "open-image-new-tab":
        await this.openMenuTab(tab, normalizePopupUrl(entry.value));
        break;
      case "copy-link":
        this.electron().clipboard.writeText(String(entry.value ?? ""));
        break;
      case "copy-image":
        wc.copyImageAt(Math.round(params?.x || 0), Math.round(params?.y || 0));
        break;
      case "save-image-as": {
        const url = String(entry.value ?? "");
        this.askedDownloads.add(url);
        wc.downloadURL(url);
        break;
      }
      case "replace-misspelling":
        wc.replaceMisspelling(String(entry.value ?? ""));
        break;
      case "cut":
        wc.cut();
        break;
      case "copy":
        wc.copy();
        break;
      case "paste":
        wc.paste();
        break;
      case "select-all":
        wc.selectAll();
        break;
      case "search-web":

        await this.openMenuTab(tab, `${SEARCH_URL}${encodeURIComponent(String(entry.value ?? ""))}`);
        break;
      case "back":
        await this.goBack(tab);
        break;
      case "forward":
        if (navigationFlag(wc, "canGoForward")) {
          await this.beforeNavigation(tab);
          wc.navigationHistory.goForward();
        }
        break;
      case "reload":
        await this.beforeNavigation(tab);
        wc.reload();
        break;
      case "view-source":
        await this.openMenuTab(tab, `${VIEW_SOURCE_PREFIX}${entry.value}`);
        break;
      case "inspect":
        this.openDevTools(tab, { x: params?.x, y: params?.y });
        break;
      default:

        break;
    }
    this.emitState(scope);
  },

  openMenuTab(tab, url) {
    if (!url) return Promise.resolve(null);
    return this.trackPopupTab(this.createTab(tab.scopeKey, url, "human")).catch(() => null);
  },
};
