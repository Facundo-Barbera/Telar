const { randomUUID } = require("node:crypto");
const { isProtectedUrl } = require("./protected-urls");
const { ProfileRegistry } = require("./browser-profiles");
const { serializeInventory, parseInventory } = require("./browser-tab-store");
const {
  SitePermissionStore,
  PermissionPrompts,
  installSitePermissions,
  desktopCaptureSources,
} = require("./site-permissions");
const { installDownloadHandler } = require("./browser-downloads");
const { VIEWPORT_PRESETS, presetOf } = require("./viewport-presets");
const { CLOSED_BY_PERSON_MESSAGE, DEFER_MAX_MS, DEFER_POLL_MS, MAX_LIVE_VIEWS, RPC_TIMEOUT_MS, TAB_SELECT_CHORDS, createElectronView, electronSessionFor, errorResult, humanActiveOn, isReadTool, navigationFlag, okText, sleep, staleView, textOfResult, mixin } = require("./shared");
const { MAX_LOG_ITEMS, MAX_LOG_TEXT, renderConsole, renderNetwork, renderSnapshot } = require("./render");
const { ZOOM_STEPS, fitViewport, resolveColorScheme, resolveViewport, resolveZoom, zoomStep } = require("./viewport");
const { createExternalLinkPolicy, externalOpenTarget, looksLikeAddress, normalizeUrl } = require("./urls");
const { keyChord } = require("./page-input");

class DesktopBrowserManager {
  constructor(window, dependencies = {}) {
    this.window = window;
    this.createView = dependencies.createView || createElectronView;
    this.createId = dependencies.createId || randomUUID;
    this.wait = dependencies.wait || sleep;

    this.electron = dependencies.electron || (() => require("electron"));

    this.onChordScope = dependencies.onChordScope || (() => {});

    this.keyFocusedTabId = null;
    this.tabs = [];

    this.activeTabIds = new Map();

    this.agentTabIds = new Map();

    this.agentTabClosed = new Map();

    this.scopesClosedByPerson = new Set();
    this.visibleScopeKey = null;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };

    this.boundsByScope = new Map();

    this.radiusByScope = new Map();

    this.boundsEmit = null;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
    this.version = 0;
    this.maxLiveViews = dependencies.maxLiveViews || MAX_LIVE_VIEWS;
    this.rpcTimeoutMs = dependencies.rpcTimeoutMs || RPC_TIMEOUT_MS;
    this.activeToolCalls = new Map();
    this.pendingPopupTabs = new Set();

    this.lastAgentInputAt = new Map();
    this.now = dependencies.now || Date.now;

    this.onControlChanged = dependencies.onControlChanged || null;

    this.onVisited = dependencies.onVisited || null;

    this.uiHolds = new Map();

    this.heldLoginCapture = null;
    this.onLoginEntryFinished = dependencies.onLoginEntryFinished || null;
    this._disposed = false;

    this._persistScheduled = false;

    this.profiles = dependencies.profiles || new ProfileRegistry(null);

    this.onProfileMigrated = dependencies.onProfileMigrated || null;
    this.scopeProfiles = new Map();
    this.scopeProjects = new Map();

    this.scopeProfileOverrides = new Map();

    this.extensionHosts = new Map();
    this.createExtensionHost = dependencies.createExtensionHost || null;

    this.sitePermissions = dependencies.sitePermissions || new SitePermissionStore(null);
    this.permissionPrompts =
      dependencies.permissionPrompts ||
      new PermissionPrompts({ deliver: (record) => this.deliverPermissionPrompt(record), now: this.now });

    this.installSitePermissions = dependencies.installSitePermissions || installSitePermissions;

    this.captureSources = dependencies.captureSources || desktopCaptureSources();

    this.sessionFor = dependencies.sessionFor || electronSessionFor;
    this.preparedPartitions = new Set();

    this.downloadsPath = dependencies.downloadsPath || (() => this.electron().app.getPath("downloads"));
    this.installDownloads = dependencies.installDownloads || installDownloadHandler;

    this.askedDownloads = new Set();

    this.tabStore = dependencies.tabStore || null;
    this.restoreInventory(this.tabStore ? this.tabStore.load() : null);

    this.window?.webContents?.on?.("zoom-changed", () => {
      if (this._disposed) return;
      this.applyVisibility();
    });

    this.displayScaleFactor =
      dependencies.scaleFactor || (() => this.electron().screen.getDisplayMatching(this.window.getBounds()).scaleFactor);

    this.window?.on?.("moved", () => {
      if (!this._disposed) this.applyShownGeometry();
    });
  }

  restoreInventory(document) {
    for (const scope of parseInventory(document, this.profiles)) {
      if (this.scopeTabs(scope.scopeKey).length) continue;

      const profile = scope.profile;
      this.scopeProfiles.set(scope.scopeKey, profile.id);
      if (scope.projectKey) this.scopeProjects.set(scope.scopeKey, scope.projectKey);
      if (scope.overridden) this.scopeProfileOverrides.set(scope.scopeKey, profile.id);
      for (const remembered of scope.tabs) {
        const tabProfile = remembered.profileId ? this.profiles.get(remembered.profileId) : null;
        const tab = this.newTabRecord(scope.scopeKey, tabProfile || profile, remembered.openedBy);
        tab.id = remembered.id;
        tab.url = remembered.url;
        tab.title = remembered.title;
        if (remembered.viewport) tab.viewport = remembered.viewport;

        if (remembered.viewportMode === "fixed") tab.viewportMode = "fixed";
        else if (remembered.viewportMode === "fit") tab.viewportMode = "fit";
        else tab.viewportMode = remembered.viewport && presetOf(remembered.viewport) !== "default" ? "fixed" : "fit";
        tab.restored = true;
        this.tabs.push(tab);
      }
      this.activeTabIds.set(scope.scopeKey, scope.activeTabId);
    }
  }

  inventory() {
    return serializeInventory({
      tabs: this.tabs.map((tab) => ({
        scopeKey: tab.scopeKey,
        id: tab.id,

        url: tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() || tab.url : tab.url,
        title: tab.title,
        openedBy: tab.openedBy,
        profileId: tab.profileId,
        ...(tab.viewport ? { viewport: tab.viewport } : {}),
        viewportMode: this.viewportModeOf(tab),
      })),
      profiles: this.scopeProfiles,
      projects: this.scopeProjects,
      overrides: this.scopeProfileOverrides,
      active: this.activeTabIds,
    });
  }

  persist() {
    if (!this.tabStore || this._disposed || this._persistScheduled) return;
    this._persistScheduled = true;
    queueMicrotask(() => {
      this._persistScheduled = false;

      if (!this.tabStore || this._disposed) return;
      this.tabStore.save(this.inventory());
    });
  }

  emitAllStates() {
    for (const scope of new Set([...this.tabs.map((tab) => tab.scopeKey), ...this.scopeProfiles.keys()])) this.emitState(scope);
  }

  addUiHold(id, reason) {
    const key = String(id);
    if (!this.uiHolds.has(key)) this.uiHolds.set(key, reason || "1Password");
  }

  removeUiHold(id) {
    this.uiHolds.delete(String(id));
  }

  requireScope(scopeKey) {
    const value = String(scopeKey || "").trim();
    if (!value) throw new Error("A browser session scope is required.");
    return value;
  }

  scopeTabs(scopeKey) {
    const scope = this.requireScope(scopeKey);
    return this.tabs.filter((tab) => tab.scopeKey === scope);
  }

  scopeClaim(scopeKey) {
    const wanted = String(scopeKey ?? "").trim();
    if (!wanted || this._disposed || this.window?.isDestroyed?.()) return 0;

    const bySession = !wanted.includes("#");
    let best = 0;
    const consider = (scope, rank) => {
      if (typeof scope !== "string" || !scope) return;
      const exact = scope === wanted;
      if (!exact && !(bySession && scope.startsWith(`${wanted}#`))) return;
      const claim = exact ? EXACT_SCOPE_CLAIM + rank : rank;
      if (claim > best) best = claim;
    };
    consider(this.visibleScopeKey, SCOPE_CLAIM.visible);
    for (const scope of this.boundsByScope.keys()) consider(scope, SCOPE_CLAIM.panel);

    for (const scope of this.scopesClosedByPerson) consider(scope, SCOPE_CLAIM.panel);
    for (const tab of this.tabs) if (tab.view) consider(tab.scopeKey, SCOPE_CLAIM.pages);
    return best;
  }

  state(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    const activeTabId = this.activeTabIds.get(scope) ?? null;
    const agentTabId = this.peekTarget(scope, {})?.id ?? null;
    return {
      scopeKey: scope,

      profileKey: this.profileOf(scope),

      profile: this.activeProfile(scope),
      profiles: this.listProfiles(),
      available: true,
      running: true,
      provider: "desktop",

      controller: (() => { const tab = tabs.find((entry) => entry.id === activeTabId); return tab ? this.tabActivity(tab) : "idle"; })(),
      tabs: tabs.map((tab, index) => ({
        index,
        id: tab.id,
        title: tab.title || `Tab ${index + 1}`,
        url: tab.url || "about:blank",
        active: tab.id === activeTabId,

        agentFocus: tab.id === agentTabId,
        loading: tab.loading,
        controller: this.tabActivity(tab),
        openedBy: tab.openedBy || "agent",

        profileId: tab.profileId || null,
        favicon: tab.faviconUrl || null,

        sleeping: !tab.view,

        devtools: this.devToolsOpen(tab),
        viewport: this.viewportInfo(tab),

        zoom: tab.zoom || 1,

        colorScheme: tab.colorScheme || "system",

        preview: this.previewing(tab),
        canGoBack: tab.view ? navigationFlag(tab.view.webContents, "canGoBack") : false,
        canGoForward: tab.view ? navigationFlag(tab.view.webContents, "canGoForward") : false,
      })),

      presentation: (() => {
        const tab = tabs.find((entry) => entry.id === activeTabId);
        if (!tab) return null;
        const viewport = this.effectiveViewport(tab);
        const fit = this.isNativeFit(tab) ? { scale: 1, rect: { ...this.bounds } } : fitViewport(viewport, this.bounds, this.zoomOf(tab));
        return { ...viewport, mode: this.viewportModeOf(tab), scale: fit.scale, zoom: this.zoomOf(tab), rect: fit.rect, bounds: this.bounds, presets: VIEWPORT_PRESETS };
      })(),
      screenshot: null,
      error: null,
      version: this.version,
    };
  }

  emitState(scopeKey, extra) {
    this.pushState(scopeKey, extra);

    this.persist();
  }

  pushState(scopeKey, extra) {
    const scope = this.requireScope(scopeKey);

    if (this.boundsEmit?.scope === scope) this.cancelBoundsEmit();
    this.version += 1;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:state", extra ? { ...this.state(scope), ...extra } : this.state(scope));
    }
  }

  async action(scopeKey, action) {
    const scope = this.requireScope(scopeKey);
    const kind = action?.action;

    if (kind === "navigate" || kind === "back" || kind === "forward" || kind === "reload") {
      this.noteHumanInput(scope, { force: true });
    }

    if (kind === "intent") {
      this.noteHumanInput(scope, { force: true });
      return this.state(scope);
    }

    if (kind === "toggle-devtools") return this.toggleDevTools(scope);

    if (kind === "hard-reload") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      this.noteHumanInput(scope, { force: true });
      await this.beforeNavigation(tab);

      tab.view.webContents.reloadIgnoringCache();
      return this.state(scope);
    }
    if (kind === "zoom") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      tab.zoom = zoomStep(tab.zoom, action.direction);
      this.applyZoom(tab);
      this.emitState(scope);
      return this.state(scope);
    }
    if (kind === "appearance") {
      const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
      tab.colorScheme = resolveColorScheme(action.scheme);
      await this.applyGeometry(tab);
      this.emitState(scope);
      return this.state(scope);
    }
    if (kind === "preview") return this.openPreview(scope, action.index);
    if (kind === "end-preview") return this.closePreview(scope, action.index);
    if (kind === "new") return (await this.createTab(scope, action.url || "about:blank", "human"), this.state(scope));
    if (kind === "close") return (this.closeTab(scope, action.index, "human"), this.state(scope));

    if (kind === "resize") {
      const tab = action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index);
      await this.resizeTab(tab, action);

      return action.live === true ? null : this.state(scope);
    }
    return this.performAction(scope, action, "human");
  }

  persistSync() {
    if (!this.tabStore || this._disposed) return;
    this.tabStore.flushSync(this.inventory());
  }

  async performAction(scopeKey, action, opener = "agent") {
    const scope = this.requireScope(scopeKey);
    switch (action?.action) {
      case "new":
        await this.createTab(scope, action.url || "about:blank", opener);
        break;
      case "select":
        await this.selectTab(scope, action.index);
        break;
      case "close":
        this.closeTab(scope, action.index, opener);
        break;

      case "duplicate": {
        const source = action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index);
        const live = source.view && !source.view.webContents.isDestroyed() ? source.view.webContents.getURL() : "";
        await this.createTab(scope, live || source.url || "about:blank", opener);
        break;
      }
      case "navigate": {
        const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : await this.createTab(scope, "about:blank", opener);
        await this.navigateTab(tab, action.url);
        break;
      }
      case "back":
        await this.goBack(await this.wakeTab(this.activeTab(scope)));
        break;
      case "forward": {
        const tab = await this.wakeTab(this.activeTab(scope));
        const wc = tab.view.webContents;
        if (navigationFlag(wc, "canGoForward")) {
          await this.beforeNavigation(tab);
          wc.navigationHistory.goForward();
        }
        break;
      }

      case "reload": {
        const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));
        await this.beforeNavigation(tab);
        tab.view.webContents.reload();
        break;
      }
      default:
        throw new Error("Unknown desktop browser action.");
    }
    return this.state(scope);
  }

  async callTool(scopeKey, name, args = {}) {
    const scope = this.requireScope(scopeKey);
    return this.callToolInner(scope, name, args);
  }

  async callToolInner(scope, name, args) {
    if (this.scopesClosedByPerson.has(scope) && !(name === "browser_tabs" && args.action === "new")) {
      return errorResult(new Error(CLOSED_BY_PERSON_MESSAGE));
    }
    const read = isReadTool(name, args);

    if (name !== "browser_tabs") {
      const candidate = this.scopeTabs(scope).length ? this.peekTarget(scope, args) : null;
      if (candidate && isProtectedUrl(candidate.url)) {
        return errorResult(new Error("That tab is showing an extension page. Browser tools do not read or act on extension pages."));
      }
    }

    let targetTab = null;
    if (!read) {
      if (name === "browser_tabs") {
        if (args.action === "close") {
          try {
            targetTab = args.index === undefined ? this.agentTab(scope) : this.tabAt(scope, args.index);
          } catch (error) {
            return errorResult(error);
          }
        }
      } else if (this.scopeTabs(scope).length) {
        targetTab = this.peekTarget(scope, args);
      }
    }

    let readTab = null;
    let readGeneration = -1;
    if (name === "browser_snapshot" || name === "browser_take_screenshot") {
      readTab = this.peekTarget(scope, args);
      readGeneration = readTab ? readTab.generation : -1;
    }

    if (targetTab) {
      const enqueuedAt = this.now();
      const run = () => this.runOnTab(scope, name, args, targetTab, enqueuedAt, (action) => this.dispatch(scope, name, args, action));
      const queued = targetTab.queue.then(run, run);
      targetTab.queue = queued.catch(() => undefined);
      return queued;
    }
    if (!read) this.lastAgentInputAt.set(scope, this.now());
    const outcome = this.protectedPostcheck(readTab, await this.dispatch(scope, name, args));
    if (readTab && this.tabs.includes(readTab) && !outcome.isError && readTab.generation === readGeneration) {
      this.noteObserved(readTab);
    }
    return outcome;
  }

  protectedPostcheck(tab, outcome) {
    if (!tab || !this.tabs.includes(tab) || outcome.isError) return outcome;
    const current = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() || tab.url : tab.url;
    if (isProtectedUrl(current)) {
      return errorResult(new Error("That tab is now showing an extension page. Browser tools do not read or act on extension pages."));
    }
    return outcome;
  }

  async runOnTab(scope, name, args, tab, enqueuedAt, dispatch) {
    const index = () => Math.max(0, this.scopeTabs(scope).indexOf(tab));

    const deadline = enqueuedAt + DEFER_MAX_MS;
    while (this.tabs.includes(tab) && this.humanActive(tab)) {
      if (this.now() >= deadline) return errorResult(new Error(humanActiveOn(tab, index())));
      await this.wait(DEFER_POLL_MS);
    }
    if (!this.tabs.includes(tab)) return errorResult(new Error(`Browser tab ${index()} was closed.`));

    const actsOnPage = name !== "browser_navigate" && name !== "browser_navigate_back" && name !== "browser_tabs" && name !== "browser_resize";
    if (actsOnPage && tab.observedGeneration !== tab.generation) {
      return errorResult(new Error(staleView(tab, index(), tab.staleReason || "it changed")));
    }
    const generationAtStart = tab.generation;
    tab.interruptedAt = undefined;
    const action = { tab, ticket: this.nextTicket(tab), generation: generationAtStart, startedAt: this.now(), cancelled: false };
    tab.agentBusy += 1;
    this.lastAgentInputAt.set(scope, this.now());
    this.journalControl(tab, "agent");
    try {
      const outcome = this.protectedPostcheck(tab, await dispatch(action));
      if (!this.tabs.includes(tab) || outcome.isError) return outcome;

      const navigational = name === "browser_navigate" || name === "browser_navigate_back" || name === "browser_tabs" || name === "browser_resize";
      if (tab.interruptedAt !== undefined) {
        return errorResult(new Error(`${textOfResult(outcome)} ${humanActiveOn(tab, index())}`));
      }
      if (!navigational && tab.generation !== generationAtStart) {
        return errorResult(new Error(`${textOfResult(outcome)} ${staleView(tab, index(), tab.staleReason || "it changed")}`));
      }
      return outcome;
    } finally {
      tab.agentBusy = Math.max(0, tab.agentBusy - 1);
      this.lastAgentInputAt.set(scope, this.now());
      if (this.tabs.includes(tab)) this.journalControl(tab, this.humanActive(tab) ? "human" : "idle");
    }
  }

  async dispatch(scope, name, args, action = null) {
    const pinned = action ? action.tab : null;

    const target = async () => {
      if (!pinned) return this.wakeTab(this.tabFor(scope, args));
      if (!this.tabs.includes(pinned)) throw new Error("The tab this action was queued for was closed.");
      return this.wakeTab(pinned);
    };
    this.activeToolCalls.set(scope, (this.activeToolCalls.get(scope) || 0) + 1);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        if (action) action.cancelled = true;
        reject(new Error(`Browser action ${name} timed out.`));
      }, this.rpcTimeoutMs);
    });
    const operation = (async () => {
      switch (name) {
        case "browser_tabs":
          if (args.action === "list") return this.listTabs(scope);
          if (args.action === "new") { if (isProtectedUrl(args.url)) throw new Error("Browser tools cannot open extension pages."); await this.createTab(scope, args.url || "about:blank", "agent"); return this.listTabs(scope); }

          if (args.action === "select") { await this.focusAgentTab(scope, args.index); return this.listTabs(scope); }
          if (args.action === "close") { this.closeTabRef(pinned || (args.index === undefined ? this.agentTab(scope) : this.tabAt(scope, args.index)), "agent"); return this.listTabs(scope); }
          throw new Error("Unknown browser_tabs action.");
        case "browser_navigate": {
          if (isProtectedUrl(args.url)) throw new Error("Browser tools cannot open extension pages.");
          const tab = pinned && this.tabs.includes(pinned) ? pinned : this.scopeTabs(scope).length ? this.tabFor(scope, args) : await this.createTab(scope);
          await this.navigateTab(tab, args.url);
          return okText(`Navigated to ${tab.view.webContents.getURL()}.`);
        }
        case "browser_navigate_back": await this.goBack(await target()); return okText("Navigated back.");
        case "browser_snapshot": return this.snapshot(await this.wakeTab(this.tabFor(scope, args)), args);
        case "browser_click": return this.click(await target(), args, action);
        case "browser_type": return this.type(await target(), args, action);
        case "browser_fill_form": return this.fillForm(await target(), args, action);
        case "browser_select_option": return this.selectOption(await target(), args, action);
        case "browser_press_key": return this.press(await target(), args, action);
        case "browser_hover": return this.hover(await target(), args);
        case "browser_drag": return this.drag(await target(), args, action);
        case "browser_paste": return this.paste(await target(), args, action);
        case "browser_copy": return this.copy(await target(), action);
        case "browser_resize": {
          const tab = await target();
          const size = await this.resizeTab(tab, args);
          const mode = this.viewportModeOf(tab) === "fit" ? " (fit to panel — follows the panel while shown)" : presetOf(size) ? ` (${presetOf(size)})` : "";
          return okText(`Resized the viewport to ${size.width}×${size.height}${mode}. Take a fresh snapshot before acting on the page.`);
        }
        case "browser_take_screenshot": return this.screenshot(await this.wakeTab(this.tabFor(scope, args)), args);
        case "browser_console_messages": {
          const tab = await this.wakeTab(this.tabFor(scope, args));
          await this.ensureDebugger(tab);
          return okText(renderConsole(tab.console, { level: args.level, all: args.all === true }));
        }
        case "browser_network_requests": {
          const tab = await this.wakeTab(this.tabFor(scope, args));
          await this.ensureDebugger(tab);
          return okText(renderNetwork(tab.network, { filter: args.filter }));
        }
        default: throw new Error(`Unsupported desktop browser tool: ${name}.`);
      }
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      return errorResult(error);
    } finally {
      clearTimeout(timeoutId);
      const remaining = Math.max(0, (this.activeToolCalls.get(scope) || 1) - 1);
      if (remaining) this.activeToolCalls.set(scope, remaining);
      else this.activeToolCalls.delete(scope);
      for (const tab of this.scopeTabs(scope)) this.finishDeferredHibernate(tab);
    }
  }

  forgetScope(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.scopeProfiles.delete(scope);
    this.scopeProjects.delete(scope);
    this.scopeProfileOverrides.delete(scope);
    this.boundsByScope.delete(scope);
    this.radiusByScope.delete(scope);
    this.lastAgentInputAt.delete(scope);
    this.activeToolCalls.delete(scope);
    this.activeTabIds.delete(scope);
    this.agentTabIds.delete(scope);
    this.agentTabClosed.delete(scope);
    this.scopesClosedByPerson.delete(scope);
  }

  releaseScope(scopeKey, destroy = false, { closedByPerson = false } = {}) {
    const scope = this.requireScope(scopeKey);
    const scoped = this.scopeTabs(scope);

    if (destroy && closedByPerson && scoped.length) {
      this.scopesClosedByPerson.add(scope);
      this.agentTabIds.delete(scope);
      this.agentTabClosed.delete(scope);
    }

    if (destroy) {
      for (const tab of scoped) this.journalControl(tab, "idle");
    }
    for (const tab of scoped) this.requestHibernate(tab, destroy);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();

    if (destroy && !closedByPerson && !this.scopeTabs(scope).length) this.forgetScope(scope);
    this.emitState(scope);
  }

  adoptScope(fromScopeKey, toScopeKey) {
    const from = this.requireScope(fromScopeKey);
    const to = this.requireScope(toScopeKey);
    if (from === to) return this.state(to);
    const sourceTabs = this.scopeTabs(from);
    if (sourceTabs.length && this.scopeTabs(to).length) {
      throw new Error("Cannot merge two browser session scopes.");
    }

    const fromProject = this.profileOf(from);
    const toProject = this.profileOf(to);
    if (toProject) {
      const targetPartition = this.partitionOf(to);
      if (sourceTabs.some((tab) => tab.partition !== targetPartition)) {
        throw new Error("Cannot adopt tabs across browser profiles (different projects).");
      }
    } else if (fromProject) {
      this.scopeProjects.set(to, fromProject);
      const profileId = this.scopeProfiles.get(from);
      if (profileId) this.scopeProfiles.set(to, profileId);
      const override = this.scopeProfileOverrides.get(from);
      if (override) this.scopeProfileOverrides.set(to, override);
    }
    const sourceActiveId = this.activeTabIds.get(from) ?? null;

    const sourceAgentId = this.agentTabIds.get(from) ?? null;
    for (const tab of sourceTabs) tab.scopeKey = to;
    if (sourceTabs.length) {
      this.activeTabIds.set(to, sourceActiveId);
      if (sourceAgentId) this.agentTabIds.set(to, sourceAgentId);
    }

    this.forgetScope(from);
    if (this.visibleScopeKey === from) this.visibleScopeKey = to;
    this.applyVisibility();
    this.emitState(from);
    this.emitState(to);
    return this.state(to);
  }

  diagnostics() {
    const countListeners = (emitter) => {
      if (!emitter || typeof emitter.eventNames !== "function" || typeof emitter.listenerCount !== "function") return 0;
      let total = 0;
      for (const event of emitter.eventNames()) total += emitter.listenerCount(event);
      return total;
    };
    let liveViews = 0;
    let wcListeners = 0;
    let consoleEntries = 0;
    let networkEntries = 0;
    let expectedReports = 0;
    let refs = 0;
    for (const tab of this.tabs) {
      consoleEntries += tab.console.length;
      networkEntries += tab.network.length;
      expectedReports += tab.expectedReports.length;
      refs += tab.refs.size;
      const wc = tab.view && !tab.view.webContents.isDestroyed?.() ? tab.view.webContents : null;
      if (!wc) continue;
      liveViews += 1;
      wcListeners += countListeners(wc) + countListeners(wc.debugger);
    }
    return {
      scopes: new Set([...this.tabs.map((tab) => tab.scopeKey), ...this.scopeProfiles.keys()]).size,
      tabs: this.tabs.length,
      liveViews,
      wcListeners,
      extensionHosts: this.extensionHosts.size,
      consoleEntries,
      networkEntries,
      expectedReports,
      refs,

      scopeEntries:
        this.scopeProfiles.size +
        this.scopeProjects.size +
        this.scopeProfileOverrides.size +
        this.boundsByScope.size +
        this.radiusByScope.size +
        this.lastAgentInputAt.size +
        this.activeToolCalls.size +
        this.activeTabIds.size +
        this.agentTabIds.size +
        this.agentTabClosed.size +
        this.scopesClosedByPerson.size,
      pendingPopups: this.pendingPopupTabs.size,
      uiHolds: this.uiHolds.size,
    };
  }

  destroy() {
    if (this.tabStore && !this._disposed) this.tabStore.flushSync(this.inventory());

    this._disposed = true;
    this.cancelBoundsEmit();

    this.permissionPrompts.dispose();
    for (const tab of [...this.tabs]) {
      this.hibernateTab(tab);
    }
    this.tabs = [];
    this.activeTabIds.clear();
    this.agentTabIds.clear();
    this.agentTabClosed.clear();
    this.scopesClosedByPerson.clear();
    this.boundsByScope.clear();
    this.radiusByScope.clear();
    this.lastAgentInputAt.clear();
    this.activeToolCalls.clear();

    for (const host of this.extensionHosts.values()) {
      try {
        host.dispose?.();
      } catch {
      }
    }
    this.extensionHosts.clear();
    this.visibleScopeKey = null;
  }
}

mixin(DesktopBrowserManager.prototype, require("./profiles"), require("./interaction"), require("./geometry"), require("./tabs"), require("./tab-wiring"), require("./tools"));

const SCOPE_CLAIM = { visible: 3, panel: 2, pages: 1 };

const EXACT_SCOPE_CLAIM = 10;

function managerForScope(managers, scopeKey, fallback = null) {
  let best = fallback;
  let claim = fallback ? fallback.scopeClaim(scopeKey) : 0;
  for (const manager of managers || []) {
    const next = manager.scopeClaim(scopeKey);
    if (next > claim) {
      best = manager;
      claim = next;
    }
  }
  return best;
}

module.exports = { DesktopBrowserManager, managerForScope, keyChord, createExternalLinkPolicy, externalOpenTarget, normalizeUrl, looksLikeAddress, TAB_SELECT_CHORDS, resolveViewport, resolveZoom, fitViewport, zoomStep, ZOOM_STEPS, renderSnapshot, renderConsole, renderNetwork, MAX_LOG_ITEMS, MAX_LOG_TEXT };
