const { normalizeUrl } = require("./urls");
const { HIBERNATE_GRACE_MS, MAX_TABS_PER_SCOPE, TAB_SELECT_CHORDS, navigationFlag, withTimeout } = require("./shared");

module.exports = {
  tabWebPreferences(tab) {
    return {
      partition: tab.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,

      nodeIntegrationInSubFrames: true,

      preload: require("node:path").join(__dirname, "..", "preload", "browser-tab-preload.js"),

      plugins: true,
    };
  },

  createViewForTab(tab) {
    this.preparePartition(tab.partition);
    return this.attachView(tab, this.createView({ webPreferences: this.tabWebPreferences(tab) }));
  },

  adoptViewForTab(tab, guest) {
    this.preparePartition(tab.partition);
    const view = guest
      ? this.createView({ webContents: guest })
      : this.createView({ webPreferences: this.tabWebPreferences(tab) });
    return this.attachView(tab, view);
  },

  attachView(tab, view) {
    tab.documentReady = false;
    tab.canvas = undefined;
    this.applyCanvas(tab, view);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    tab.view = view;
    tab.hibernating = false;
    tab.refs.clear();
    tab.console = [];
    tab.network = [];
    tab.debuggerReady = false;
    tab.debuggerListenersBound = false;

    this.forgetEmulation(tab);

    tab.borderRadius = undefined;
    this.bindTab(tab);

    this.ensureViewport(tab).catch(() => {});
    return view;
  },

  async wakeTab(tab) {
    tab.lastUsedAt = Date.now();
    if (tab.view) return tab;
    const view = this.createViewForTab(tab);
    await this.readyHostForTab(tab, view);
    const destination = normalizeUrl(tab.url);

    tab.restored = false;
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    return tab;
  },

  async readyHostForTab(tab, view) {
    const host = this.extensionHostFor(tab.partition);
    if (!host) return;
    if (typeof host.whenReady === "function") {
      try { await host.whenReady(); } catch {  }
    }

    if (tab.view === view && !view.webContents.isDestroyed()) host.addTab(view.webContents, this.window);
  },

  beginNavigation(tab) {
    tab.navigationPending += 1;
  },

  endNavigation(tab) {
    tab.navigationPending = Math.max(0, tab.navigationPending - 1);
    this.finishDeferredHibernate(tab);
  },

  async loadTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.beforeNavigation(tab);
      await this.loadAllowingReplacement(tab, url);
    } finally {
      this.endNavigation(tab);
    }
  },

  async loadAllowingReplacement(tab, url) {
    const wc = tab.view.webContents;

    let starts = 0;
    let committed = false;
    let failure = null;
    let settle = null;
    const commit = () => { if (starts >= 2) { committed = true; settle?.(null); } };
    const onStart = (details) => {
      if (details?.isMainFrame) { starts += 1; if (!details.isSameDocument) committed = false; }
    };
    const onFail = (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      failure = Object.assign(new Error(`${description || "load failed"} (${code}) loading ${failedUrl}`), { errno: code });
      settle?.(failure);
    };
    const onStop = () => {
      if (!committed) settle?.(Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}' — the navigation was stopped before a page committed.`), { errno: -3 }));
    };
    const onDestroyed = () => settle?.(new Error("The tab was closed while the page was still loading."));
    wc.on("did-start-navigation", onStart);
    wc.on("did-navigate", commit);
    wc.on("did-navigate-in-page", commit);
    wc.on("did-fail-load", onFail);
    wc.on("did-stop-loading", onStop);
    wc.on("destroyed", onDestroyed);
    try {
      await wc.loadURL(url);
    } catch (error) {
      const aborted = error && (error.errno === -3 || error.code === "ERR_ABORTED" || /ERR_ABORTED/.test(String(error.message)));

      const loading = typeof wc.isLoading === "function" && !wc.isDestroyed() && wc.isLoading();
      const replaced = aborted && !wc.isDestroyed() && (starts >= 2 || loading);
      if (!replaced) throw error;
      if (failure) throw failure;
      if (committed) return;
      if (!loading) throw error;
      await withTimeout(
        new Promise((resolve, reject) => {
          settle = (outcome) => (outcome ? reject(outcome) : resolve());
        }),
        this.rpcTimeoutMs,
        "The page kept navigating and never settled.",
      );
    } finally {
      settle = null;
      wc.removeListener("did-start-navigation", onStart);
      wc.removeListener("did-navigate", commit);
      wc.removeListener("did-navigate-in-page", commit);
      wc.removeListener("did-fail-load", onFail);
      wc.removeListener("did-stop-loading", onStop);
      wc.removeListener("destroyed", onDestroyed);
    }
  },

  async navigateTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.wakeTab(tab);
      await this.loadTab(tab, normalizeUrl(url));
    } finally {
      this.endNavigation(tab);
    }
  },

  async goBack(tab) {
    const wc = tab.view.webContents;
    if (navigationFlag(wc, "canGoBack")) {
      await this.beforeNavigation(tab);
      wc.navigationHistory.goBack();
    }
  },

  hibernateTab(tab) {
    if (!tab.view) return;

    this.noteTabKeyFocus(tab, false);
    this.cancelDeferredHibernate(tab);

    this.endPreview(tab);

    this.closeDevTools(tab);
    const view = tab.view;
    { const host = this.hostOfTab(tab); if (host) host.removeTab(view.webContents); }
    tab.url = view.webContents.getURL() || tab.url || "about:blank";
    tab.title = view.webContents.getTitle() || tab.title || "New tab";
    tab.hibernating = true;
    tab.view = null;
    try { this.window.contentView.removeChildView(view); } catch {}
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    tab.hibernating = false;
  },

  cancelDeferredHibernate(tab) {
    if (tab.hibernateTimer) clearTimeout(tab.hibernateTimer);
    tab.hibernateTimer = null;
    tab.hibernateWhenIdle = false;
    tab.destroyWhenIdle = false;
  },

  removeTab(tab) {
    const scope = tab.scopeKey;

    this.permissionPrompts.cancelWhere((record) => record.tabId === tab.id);
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.noteAgentTabClosed(tab);
    if (this.activeTabIds.get(scope) === tab.id) {
      const remaining = this.scopeTabs(scope);
      this.activeTabIds.set(scope, remaining.at(-1)?.id ?? null);
    }
    if (!this.scopeTabs(scope).length) this.activeTabIds.delete(scope);
    this.applyVisibility();
  },

  finishDeferredHibernate(tab, force = false) {
    if (
      !tab.hibernateWhenIdle ||
      !tab.view ||
      ((tab.loading || tab.navigationPending > 0 || (this.activeToolCalls.get(tab.scopeKey) || 0) > 0) && !force)
    ) return;
    const destroy = tab.destroyWhenIdle;
    this.hibernateTab(tab);
    if (destroy) {
      this.removeTab(tab);
      this.emitState(tab.scopeKey);
    }
  },

  requestHibernate(tab, destroy = false) {
    if (!tab.view) {
      if (destroy) this.removeTab(tab);
      return;
    }
    if (tab.loading || tab.navigationPending > 0 || (this.activeToolCalls.get(tab.scopeKey) || 0) > 0) {
      tab.hibernateWhenIdle = true;
      tab.destroyWhenIdle ||= destroy;
      if (!tab.hibernateTimer) {
        tab.hibernateTimer = setTimeout(
          () => this.finishDeferredHibernate(tab, true),
          HIBERNATE_GRACE_MS,
        );
      }
      return;
    }
    this.hibernateTab(tab);
    if (destroy) this.removeTab(tab);
  },

  enforceLiveViewBudget(exceptTab) {
    const live = this.tabs.filter((tab) => tab.view && tab !== exceptTab);
    while (live.length + (exceptTab?.view ? 1 : 0) > this.maxLiveViews) {
      const candidate = live
        .filter(
          (tab) =>
            tab.scopeKey !== this.visibleScopeKey &&
            (this.activeToolCalls.get(tab.scopeKey) || 0) === 0,
        )
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!candidate) break;
      this.hibernateTab(candidate);
      const index = live.indexOf(candidate);
      if (index >= 0) live.splice(index, 1);
    }
  },

  async createTab(scopeKey, url = "about:blank", openedBy = "agent") {
    const scope = this.requireScope(scopeKey);
    if (this.scopeTabs(scope).length >= MAX_TABS_PER_SCOPE) {
      throw new Error(`Tab limit reached (${MAX_TABS_PER_SCOPE} per session). Close a tab first.`);
    }

    this.partitionOf(scope);
    this.scopesClosedByPerson.delete(scope);
    const tab = this.newTabRecord(scope, this.activeProfile(scope), openedBy);
    const wasEmpty = this.scopeTabs(scope).length === 0;
    this.tabs.push(tab);

    if (openedBy === "human" || wasEmpty) this.activeTabIds.set(scope, tab.id);
    if (openedBy === "agent") {
      this.agentTabIds.set(scope, tab.id);
      this.agentTabClosed.delete(scope);
    }
    const view = this.createViewForTab(tab);
    const humanTabBefore = this.activeTabIds.get(scope);
    await this.readyHostForTab(tab, view);

    if (
      openedBy === "agent" &&
      humanTabBefore !== undefined &&
      this.activeTabIds.get(scope) !== humanTabBefore &&
      this.tabs.some((candidate) => candidate.id === humanTabBefore)
    ) {
      this.activeTabIds.set(scope, humanTabBefore);
    }
    this.applyVisibility();

    if (openedBy === "human") tab.lastHumanInputAt = this.now();
    this.journalControl(tab, openedBy === "human" ? "human" : "agent");
    const destination = normalizeUrl(url);
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    this.emitState(scope);
    return tab;
  },

  activeTab(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) =>
      candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope),
    );
    if (!tab) throw new Error("Open a browser tab before using browser controls.");
    return tab;
  },

  tabAt(scopeKey, index) {
    const tab = this.scopeTabs(scopeKey)[Number(index)];
    if (!tab) throw new Error(`Browser tab ${String(index)} does not exist.`);
    return tab;
  },

  agentTab(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const closed = this.agentTabClosed.get(scope);
    if (closed) {
      this.agentTabClosed.delete(scope);
      throw new Error(`The tab you were working in (${closed}) was closed. List the tabs and choose one to continue in.`);
    }
    const focused = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.agentTabIds.get(scope));
    if (focused) return focused;
    this.agentTabIds.delete(scope);
    return this.activeTab(scope);
  },

  async focusAgentTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.agentTabIds.set(scope, tab.id);
    this.agentTabClosed.delete(scope);
    this.emitState(scope);
    return tab;
  },

  noteAgentTabClosed(tab) {
    if (this.agentTabIds.get(tab.scopeKey) !== tab.id) return;
    this.agentTabIds.delete(tab.scopeKey);
    this.agentTabClosed.set(tab.scopeKey, tab.title || tab.url || "untitled");
  },

  tabFor(scope, args) {
    return args && args.tabId !== undefined ? this.tabAt(scope, args.tabId) : this.agentTab(scope);
  },

  peekTarget(scope, args) {
    try {
      if (args && args.tabId !== undefined) return this.tabAt(scope, args.tabId);
      if (this.agentTabClosed.has(this.requireScope(scope))) return null;
      return this.tabFor(scope, args);
    } catch {
      return null;
    }
  },

  noteTabKeyFocus(tab, focused) {
    if (focused) {
      if (this.keyFocusedTabId === tab.id) return;
      this.keyFocusedTabId = tab.id;
    } else {
      if (this.keyFocusedTabId !== tab.id) return;
      this.keyFocusedTabId = null;
    }
    this.publishChordScope();
  },

  publishChordScope() {
    try {
      this.onChordScope(this.keyFocusedTabId ? TAB_SELECT_CHORDS : []);
    } catch {
    }
  },

  handleTabKey(tab, event, input) {
    if (!input || input.type !== "keyDown" || input.alt || input.shift) return;
    if (!(input.meta || input.control)) return;
    if (!/^[1-9]$/.test(String(input.key))) return;
    let scoped;
    try {
      scoped = this.scopeTabs(tab.scopeKey);
    } catch {
      return;
    }

    const position = Number(input.key) - 1;
    if (!scoped[position]) return;
    event.preventDefault();
    this.selectTab(tab.scopeKey, position).catch(() => {});
  },

  async selectTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.activeTabIds.set(scope, tab.id);
    { const host = tab.view ? this.hostOfTab(tab) : null; if (host) host.selectTab(tab.view.webContents); }
    this.applyVisibility();
    this.emitState(scope);
  },

  closeTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    return this.closeTabRef(index === undefined ? this.activeTab(scope) : this.tabAt(scope, index));
  },

  closeTabRef(tab) {
    const scope = tab.scopeKey;
    const scoped = this.scopeTabs(scope);
    if (!scoped.includes(tab)) throw new Error("That browser tab is already closed.");
    const position = scoped.indexOf(tab);
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.noteAgentTabClosed(tab);
    this.hibernateTab(tab);
    if (this.activeTabIds.get(scope) === tab.id) {
      const remaining = this.scopeTabs(scope);
      this.activeTabIds.set(scope, remaining[position]?.id ?? remaining[position - 1]?.id ?? null);
    }

    if (!this.scopeTabs(scope).length) return this.endBrowser(scope);
    this.applyVisibility();
    this.emitState(scope);
  },

  endBrowser(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.activeTabIds.delete(scope);
    this.boundsByScope.delete(scope);
    this.radiusByScope.delete(scope);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope, { ended: true });
  },
};
