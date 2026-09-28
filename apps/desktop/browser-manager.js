const { randomUUID } = require("node:crypto");
const { isProtectedUrl } = require("./protected-urls");
const { ProfileRegistry, requireProjectKey } = require("./browser-profiles");
const { serializeInventory, parseInventory } = require("./browser-tab-store");
const { captureEntry } = require("./login-offer");
const {
  SitePermissionStore,
  PermissionPrompts,
  installSitePermissions,
  desktopCaptureSources,
  PERMISSION_KINDS,
} = require("./site-permissions");
const { browserContextMenuTemplate } = require("./browser-context-menu");
const { installDownloadHandler } = require("./browser-downloads");
const { VIEWPORT_PRESETS, presetOf } = require("./viewport-presets");
const { BOUNDS_SETTLE_MS, CAPTURE_TIMEOUT_MESSAGE, CAPTURE_TIMEOUT_MS, CLOSED_BY_PERSON_MESSAGE, CURSOR_CLICK_LEAD_MS, CURSOR_MOVE_MS, DEFER_MAX_MS, DEFER_POLL_MS, FREEZE_TIMEOUT_MESSAGE, FREEZE_TIMEOUT_MS, HIBERNATE_GRACE_MS, HUMAN_ACTIVE_MS, HUMAN_ATTRIBUTION_GRACE_MS, MAX_LIVE_VIEWS, MAX_TABS_PER_SCOPE, RPC_TIMEOUT_MS, SYNTHETIC_REPORT_TTL_MS, TAB_SELECT_CHORDS, createElectronView, electronSessionFor, errorResult, humanActiveOn, isReadTool, navigationFlag, okText, sleep, staleView, textOfResult, withTimeout } = require("./browser/shared");
const { MAX_LOG_ITEMS, MAX_LOG_TEXT, logText, pushCapped, renderConsole, renderNetwork, renderSnapshot } = require("./browser/render");
const { DEFAULT_VIEWPORT, NO_CANVAS, PAGE_CANVAS, VIEWPORT_MIN, ZOOM_STEPS, emulationKey, fitViewport, resolveColorScheme, resolveViewport, resolveZoom, zoomStep } = require("./browser/viewport");
const { SEARCH_URL, VIEW_SOURCE_PREFIX, createExternalLinkPolicy, externalOpenTarget, looksLikeAddress, normalizePopupUrl, normalizeUrl } = require("./browser/urls");
const { PAGE_AT_POINT, PAGE_COPY, PAGE_FOCUSED_EDITABLE, PAGE_PASTE, capCopied, keyChord, pageLabel, pointText } = require("./browser/page-input");

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

  declareProfile(scopeKey, projectKey) {
    const scope = this.requireScope(scopeKey);
    const key = requireProjectKey(projectKey);
    const current = this.scopeProjects.get(scope);
    if (current !== undefined && current !== key && this.scopeTabs(scope).length) {
      throw new Error(`Browser session ${scope} already has tabs in profile ${current}; close them before moving it to ${key}.`);
    }

    if (current !== undefined && current !== key) this.scopeProfileOverrides.delete(scope);
    this.scopeProjects.set(scope, key);
    const override = this.scopeProfileOverrides.get(scope);
    const profile = override ? this.profiles.require(override) : this.profiles.resolve(key);
    this.drainProfileMigrations();
    this.scopeProfiles.set(scope, profile.id);
    this.persist();
    return this.describeProfileBinding(scope, profile, key);
  }

  setScopeProfile(scopeKey, profileId) {
    const scope = this.requireScope(scopeKey);
    const profile = this.profiles.require(profileId);
    this.scopeProfileOverrides.set(scope, profile.id);
    this.scopeProfiles.set(scope, profile.id);
    this.persist();
    this.emitState(scope);
    return this.describeProfileBinding(scope, profile, this.scopeProjects.get(scope) ?? null);
  }

  describeProfileBinding(scope, profile, projectKey) {
    return {
      scopeKey: scope,

      profileKey: projectKey,
      profileId: profile.id,
      label: profile.label,
      ...(profile.account ? { account: profile.account } : {}),
      partition: profile.partition,
    };
  }

  drainProfileMigrations() {
    if (!this.profiles.migrations.length) return;
    const moves = this.profiles.migrations.splice(0, this.profiles.migrations.length);
    if (!this.onProfileMigrated) return;
    for (const move of moves) {
      try { this.onProfileMigrated(move.from, move.to); } catch {  }
    }
  }

  profileOf(scopeKey) {
    return this.scopeProjects.get(this.requireScope(scopeKey)) || null;
  }

  activeProfile(scopeKey) {
    const id = this.scopeProfiles.get(this.requireScope(scopeKey));
    return id ? this.profiles.get(id) : null;
  }

  partitionOf(scopeKey) {
    const profile = this.activeProfile(scopeKey);
    if (!profile) throw new Error(`Browser session ${this.requireScope(scopeKey)} is not bound to a project profile yet; nothing can open until it is.`);
    return profile.partition;
  }

  listProfiles() {
    return this.profiles.list().map((profile) => ({ ...profile, projects: this.profiles.projectsOf(profile.id) }));
  }

  deleteProfile(profileId) {
    const removed = this.profiles.remove(profileId);
    const id = removed.id;
    const fallback = this.profiles.require(this.profiles.defaultProfileId);
    const scopes = new Set();
    for (const [scope, bound] of this.scopeProfiles) {
      if (bound !== id) continue;
      if (this.scopeProfileOverrides.get(scope) === id) this.scopeProfileOverrides.delete(scope);
      const override = this.scopeProfileOverrides.get(scope);
      const project = this.scopeProjects.get(scope);
      const profile = override ? this.profiles.require(override) : project ? this.profiles.resolve(project) : fallback;
      this.scopeProfiles.set(scope, profile.id);
      scopes.add(scope);
    }
    this.drainProfileMigrations();
    let tabs = 0;
    for (const tab of this.tabs) {
      if (tab.profileId !== id) continue;
      this.hibernateTab(tab);
      const profile = this.profiles.get(this.scopeProfiles.get(tab.scopeKey)) || fallback;
      tab.profileId = profile.id;
      tab.partition = profile.partition;
      scopes.add(tab.scopeKey);
      tabs += 1;
    }
    this.persist();
    return { ...removed, sessions: scopes.size, tabs };
  }

  extensionHostFor(partition) {
    let host = this.extensionHosts.get(partition) || null;
    if (!host && this.createExtensionHost) {
      host = this.createExtensionHost(partition);
      if (host) this.extensionHosts.set(partition, host);
    }
    return host;
  }

  hostOfTab(tab) {
    return this.extensionHosts.get(tab.partition) || null;
  }

  liveOriginsByPartition() {
    const byPartition = new Map();
    for (const tab of this.tabs) {
      const wc = tab.view && !tab.view.webContents?.isDestroyed?.() ? tab.view.webContents : null;
      if (!wc || !tab.partition) continue;
      let origin = null;
      try {
        origin = new URL(wc.getURL?.() || tab.url || "about:blank").origin;
      } catch {
        origin = null;
      }

      if (!origin || origin === "null") continue;
      if (!byPartition.has(tab.partition)) byPartition.set(tab.partition, new Set());
      byPartition.get(tab.partition).add(origin);
    }
    return byPartition;
  }

  activePartitions() {
    return new Set([
      ...this.preparedPartitions,
      ...this.extensionHosts.keys(),
      ...this.tabs.map((tab) => tab.partition).filter(Boolean),
    ]);
  }

  hostForScope(scopeKey) {
    let partition;
    try { partition = this.partitionOf(scopeKey); } catch { return null; }
    return this.extensionHostFor(partition);
  }

  attachExtensionHost(host, partition) {
    if (!partition) throw new Error("attachExtensionHost needs the partition the host serves.");
    this.extensionHosts.set(partition, host);
    for (const tab of this.tabs) if (tab.view && tab.partition === partition) host.addTab(tab.view.webContents, this.window);
  }

  preparePartition(partition) {
    if (!partition || this.preparedPartitions.has(partition)) return;
    this.preparedPartitions.add(partition);
    let ses;
    try {
      ses = this.sessionFor(partition);
    } catch (error) {
      console.error(`[telar-desktop] could not reach the session for ${partition}: ${error && error.message ? error.message : error}`);
      return;
    }
    if (!ses) return;
    try {
      this.installSitePermissions(ses, {
        partition,
        store: this.sitePermissions,
        prompts: this.permissionPrompts,
        sources: this.captureSources,
        locate: (webContents) => this.locatePermission(webContents),
        onDenied: (context) => this.reportPermissionDenied(context),
      });
    } catch (error) {
      console.error(`[telar-desktop] could not install site permission handlers on ${partition}: ${error && error.message ? error.message : error}`);
    }
    try {
      this.installDownloads(ses, {
        directory: this.downloadsPath,
        shouldAsk: (url) => this.askedDownloads.delete(url),
        onStarted: (download) => this.reportDownload({ ...download, state: "started" }),
        onFinished: (download) => this.reportDownload(download),
      });
    } catch (error) {
      console.error(`[telar-desktop] could not install the download handler on ${partition}: ${error && error.message ? error.message : error}`);
    }
  }

  reportDownload({ state, path, filename, webContents }) {
    let where = { scopeKey: this.visibleScopeKey ?? null, tabId: null };
    try {
      if (webContents && !webContents.isDestroyed()) where = this.locatePermission(webContents);
    } catch {
    }
    const tab = this.tabs.find((candidate) => candidate.id === where.tabId);
    const text =
      state === "started" ? `Download started: ${filename} is being saved to ${path}`
      : state === "completed" ? `Downloaded ${filename} to ${path}`
      : `Download of ${filename} ${state === "cancelled" ? "was cancelled" : "failed"}; nothing was saved to ${path}`;
    if (tab) pushCapped(tab.console, { level: state === "started" || state === "completed" ? "info" : "error", text });
    if (!this.window.isDestroyed()) this.window.webContents.send("telar:browser:download", { ...where, state, path, filename });
  }

  locatePermission(source) {
    const id = source?.id ?? null;
    const url = typeof source?.url === "string" ? source.url : null;
    for (const tab of this.tabs) {
      if (!tab.view || tab.view.webContents.isDestroyed()) continue;
      const contents = tab.view.webContents;
      const matches = id !== null && contents.id === id;

      const sameFrame = !matches && url !== null && contents.getURL() === url;
      if (matches || sameFrame) return { scopeKey: tab.scopeKey, tabId: tab.id };
    }
    return { scopeKey: this.visibleScopeKey ?? null, tabId: null };
  }

  deliverPermissionPrompt(record) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-request", record);
  }

  answerSitePermission(requestId, answer) {
    return { answered: this.permissionPrompts.answer(requestId, answer || {}) };
  }

  pendingPermissionPrompts(scopeKey) {
    return scopeKey ? this.permissionPrompts.pending(this.requireScope(scopeKey)) : this.permissionPrompts.pending();
  }

  scopeSitePermissions(scopeKey, origin) {
    const partition = this.partitionOf(scopeKey);
    return origin
      ? { partition, origin, kinds: this.sitePermissions.listOrigin(partition, origin) }
      : { partition, origins: this.sitePermissions.list(partition) };
  }

  listSitePermissions() {
    const labels = new Map(this.profiles.list().map((profile) => [profile.partition, profile]));
    return {
      kinds: PERMISSION_KINDS,
      profiles: this.sitePermissions.all().map((entry) => ({
        partition: entry.partition,

        profileId: labels.get(entry.partition)?.id ?? null,
        label: labels.get(entry.partition)?.label ?? entry.partition,
        origins: entry.origins,
      })),
    };
  }

  forgetSitePermission({ partition, scopeKey, origin, kind } = {}) {
    const jar = partition || this.partitionOf(scopeKey);
    if (!origin) throw new Error("Forgetting a site permission needs the origin it was given to.");
    this.sitePermissions.forget(jar, origin, kind === undefined || kind === null ? undefined : kind);
    return this.listSitePermissions();
  }

  reportPermissionDenied(context) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-denied", { origin: context.origin, kinds: context.kinds, reason: context.reason });
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

  humanActive(tab) {
    return tab.lastHumanInputAt !== undefined && this.now() - tab.lastHumanInputAt < HUMAN_ACTIVE_MS;
  }

  controllerOf(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return "idle";
    return this.tabActivity(tab);
  }

  tabActivity(tab) {
    if (this.humanActive(tab)) return "human";
    if (tab.agentBusy > 0) return "agent";
    return "idle";
  }

  journalControl(tab, controller, options = {}) {
    if (tab.lastJournaled === controller) return;
    tab.lastJournaled = controller;
    if (this.onControlChanged) {
      try {
        this.onControlChanged({
          scopeKey: tab.scopeKey,
          tabId: tab.id,
          controller,

          ...(options.interrupted ? { interrupted: true } : {}),
          at: new Date(this.now()).toISOString(),
        });
      } catch {
      }
    }
  }

  noteHumanInput(scopeKey, options = {}) {
    const scope = this.requireScope(scopeKey);
    const tab = options.tab ?? this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return false;
    if (!options.force) {
      const busy = (this.activeToolCalls.get(scope) || 0) > 0;

      const now = this.now();
      tab.expectedReports = tab.expectedReports.filter((at) => now - at < SYNTHETIC_REPORT_TTL_MS);
      if (tab.expectedReports.length) {
        tab.expectedReports.shift();
        return false;
      }
      if (!busy) {
        const recent = now - (this.lastAgentInputAt.get(scope) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
        if (recent) return false;
      }
    }

    const interrupted = tab.agentBusy > 0;
    if (interrupted) tab.interruptedAt = this.now();
    tab.lastHumanInputAt = this.now();
    tab.generation += 1;
    tab.staleReason = "the human interacted";
    this.journalControl(tab, "human", { interrupted });
    this.emitState(tab.scopeKey);
    return true;
  }

  noteHumanInputFromWebContents(webContents) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (tab) this.noteHumanInput(tab.scopeKey, { tab });
  }

  noteLoginEntryFromWebContents(webContents, detail = {}) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (!tab) return;
    const capture = captureEntry({
      kind: detail.kind,
      origin: tab.url,
      profileId: tab.profileId,
      profileLabel: this.profiles.get(tab.profileId)?.label,
      tabUid: tab.id,
      at: this.now(),
    });
    if (!capture) return;
    this.heldLoginCapture = capture;

    tab.loginEntryAt = this.now();
  }

  finishLoginEntry() {
    const capture = this.heldLoginCapture;
    this.heldLoginCapture = null;
    if (!capture || !this.onLoginEntryFinished) return;
    try {
      this.onLoginEntryFinished(capture);
    } catch {
    }
  }

  loginCaptureForScope(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return null;
    return captureEntry({
      kind: "input",
      origin: tab.url,
      profileId: tab.profileId,
      profileLabel: this.profiles.get(tab.profileId)?.label,
      tabUid: tab.id,
      at: this.now(),
    });
  }

  noteNavigation(tab) {
    tab.generation += 1;
    tab.staleReason = "the page navigated";
    if (tab.loginEntryAt !== undefined) {
      tab.loginEntryAt = undefined;
      this.finishLoginEntry();
    }
  }

  noteVisited(tab, url, httpResponseCode) {
    if (!this.onVisited) return;
    if (typeof httpResponseCode === "number" && (httpResponseCode === 0 || httpResponseCode >= 400)) return;
    let parsed;
    try { parsed = new URL(String(url || "")); } catch { return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (isProtectedUrl(parsed.href)) return;
    try { this.onVisited(tab.scopeKey, parsed.href); } catch {  }
  }

  stampAgentInput(tab, reports = 0) {
    const now = this.now();

    if (tab.expectedReports.length) {
      tab.expectedReports = tab.expectedReports.filter((at) => now - at < SYNTHETIC_REPORT_TTL_MS);
    }
    for (let i = 0; i < reports; i += 1) tab.expectedReports.push(now);
    this.lastAgentInputAt.set(tab.scopeKey, now);
  }

  checkpoint(action) {
    const { tab } = action;
    const index = () => Math.max(0, this.scopeTabs(tab.scopeKey).indexOf(tab));
    if (action.cancelled) throw new Error("Stopped: this action timed out.");
    if (!this.tabs.includes(tab)) throw new Error("The tab was closed.");
    if (action.ticket !== tab.ticket) throw new Error("Stopped: a later action on this tab has started.");
    if (tab.interruptedAt !== undefined && tab.interruptedAt >= action.startedAt) {
      throw new Error(`Stopped: ${humanActiveOn(tab, index())}`);
    }
    if (tab.generation !== action.generation) {
      throw new Error(`Stopped: ${staleView(tab, index(), tab.staleReason || "it changed")}`);
    }
  }

  noteObserved(tab) {
    tab.observedGeneration = tab.generation;
  }

  nextTicket(tab) {
    tab.ticket = (tab.ticket || 0) + 1;
    return tab.ticket;
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

  scheduleBoundsEmit(scope) {
    this.cancelBoundsEmit();
    const timer = this.setTimer(() => {
      if (this.boundsEmit?.timer !== timer) return;
      this.boundsEmit = null;
      if (!this._disposed) this.pushState(scope);
    }, BOUNDS_SETTLE_MS);
    this.boundsEmit = { scope, timer };
  }

  cancelBoundsEmit() {
    if (!this.boundsEmit) return;
    this.clearTimer(this.boundsEmit.timer);
    this.boundsEmit = null;
  }

  viewportOf(tab) {
    return tab.viewport || DEFAULT_VIEWPORT;
  }

  viewportModeOf(tab) {
    return tab.viewportMode === "fixed" ? "fixed" : "fit";
  }

  fitViewportChange(tab) {
    if (this.viewportModeOf(tab) !== "fit" || !this.isTabVisible(tab)) return null;

    const stage = this.stageBounds();
    if (stage.width < VIEWPORT_MIN || stage.height < VIEWPORT_MIN) return null;
    const next = resolveViewport({ width: stage.width, height: stage.height });
    const current = this.viewportOf(tab);
    if (next.width === current.width && next.height === current.height) return null;
    return next;
  }

  syncFitViewport(tab) {
    const next = this.fitViewportChange(tab);
    if (!next) return false;
    tab.viewport = next;
    return true;
  }

  emulationSettled(tab) {
    const target = this.viewportTarget(tab);
    if (!target.emulate) return tab.viewportOverride === "native" || tab.viewportOverride === undefined;
    return tab.viewportOverride === emulationKey(target);
  }

  viewportInfo(tab) {
    const viewport = this.viewportOf(tab);
    return { width: viewport.width, height: viewport.height, preset: presetOf(viewport), mode: this.viewportModeOf(tab) };
  }

  isNativeFit(tab) {
    return this.viewportModeOf(tab) === "fit" && this.isTabVisible(tab);
  }

  cockpitZoom() {
    const factor = this.window?.webContents?.getZoomFactor?.();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  deviceScaleFactor() {
    try {
      const factor = this.displayScaleFactor();
      return Number.isFinite(factor) && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  windowRect(rect) {
    const zoom = this.cockpitZoom();
    return {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
  }

  stageBounds() {
    return this.windowRect(this.bounds);
  }

  effectiveViewport(tab) {
    if (!this.isNativeFit(tab)) return this.viewportOf(tab);
    const stage = this.stageBounds();
    return { width: stage.width, height: stage.height };
  }

  nativeRect(tab) {
    if (this.isNativeFit(tab)) return { ...this.bounds };
    return fitViewport(this.viewportOf(tab), this.bounds, this.zoomOf(tab)).rect;
  }

  zoomOf(tab) {
    return typeof tab.presentationZoom === "number" ? tab.presentationZoom : "fit";
  }

  async resizeTab(tab, input) {
    if (input && typeof input === "object" && input.zoom !== undefined && input.preset === undefined && input.width === undefined && input.height === undefined && input.mode === undefined) {
      tab.presentationZoom = resolveZoom(input.zoom);
      await this.applyGeometry(tab);
      this.emitState(tab.scopeKey);
      return this.viewportOf(tab);
    }
    const live = Boolean(input && typeof input === "object" && input.live === true);
    const dragged = Boolean(tab.liveResizeFrom);
    const previous = tab.liveResizeFrom || { viewport: tab.viewport, mode: tab.viewportMode };
    if (live) {
      tab.liveResizeFrom = previous;
      const next = resolveViewport(input, this.viewportOf(tab));
      const current = this.viewportOf(tab);
      if (next.width === current.width && next.height === current.height && tab.viewportMode === "fixed") return current;
      tab.viewport = next;
      tab.viewportMode = "fixed";
      tab.generation += 1;
      tab.staleReason = "the viewport was resized";
      await this.applyGeometry(tab);
      return next;
    }
    tab.liveResizeFrom = undefined;
    const wantsFit = input && typeof input === "object" && input.mode === "fit";
    if (wantsFit) {
      tab.viewportMode = "fit";
      this.syncFitViewport(tab);
    } else {
      const explicit = input && typeof input === "object" && (input.preset !== undefined || input.width !== undefined || input.height !== undefined || input.orientation !== undefined);
      if (explicit) tab.viewport = resolveViewport(input, this.viewportOf(tab));
      else if (input?.mode !== "fixed") throw new Error("A viewport needs a preset, a width or height, an orientation, or a mode.");
      tab.viewportMode = "fixed";
    }
    const current = this.viewportOf(tab);
    const before = previous.viewport || DEFAULT_VIEWPORT;
    const changed = current.width !== before.width || current.height !== before.height || (previous.mode === "fit") !== (tab.viewportMode === "fit");
    if (!changed) {
      if (dragged) await this.applyGeometry(tab);
      return current;
    }
    try {
      await this.applyGeometry(tab);
    } catch (error) {
      tab.viewport = previous.viewport;
      tab.viewportMode = previous.mode;
      void this.applyGeometry(tab).catch(() => {});
      throw new Error(`Could not resize the viewport: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (current.width !== before.width || current.height !== before.height) {
      tab.generation += 1;
      tab.staleReason = "the viewport was resized";
    }
    this.emitState(tab.scopeKey);
    return current;
  }

  async ensureDebuggerOnly(tab) {
    const debug = tab.view.webContents.debugger;
    if (!tab.debuggerReady) await this.ensureDebugger(tab, { sync: false });
    return debug;
  }

  applyGeometry(tab) {
    const geometry = (tab.geometry ||= { queue: Promise.resolve(), scheduled: null });
    if (geometry.scheduled) return geometry.scheduled;
    const run = geometry.queue.then(() => {
      geometry.scheduled = null;
      return this.applyGeometryNow(tab);
    });
    geometry.scheduled = run;
    geometry.queue = run.catch(() => undefined);
    return run;
  }

  async applyGeometryNow(tab) {
    const view = tab.view;
    if (!view || view.webContents.isDestroyed?.()) return;
    const place = () => {
      if (tab.view !== view || view.webContents.isDestroyed?.()) return;
      this.applyBorderRadius(tab, view);
      this.applyCanvas(tab, view);

      if (this.previewing(tab)) {
        view.setVisible(true);
        view.setBounds(this.previewRect(tab));
        return;
      }

      const shown = this.isTabShown(tab) && !this.isBlank(tab);
      view.setVisible(shown);

      if (shown) view.setBounds(this.windowRect(this.nativeRect(tab)));
    };

    const target = this.viewportTarget(tab);
    const scaleFirst = Boolean(target.view) && tab.debuggerReady && !this.isBlank(tab) && !this.emulationSettled(tab);
    if (!scaleFirst) place();
    const placed = tab.lastPlaced;
    tab.lastPlaced = { width: this.bounds.width, height: this.bounds.height };
    if (
      placed &&
      placed.width === this.bounds.width &&
      placed.height === this.bounds.height &&
      this.fitViewportChange(tab) === null &&
      this.emulationSettled(tab) &&
      !this.needsColorScheme(tab)
    ) {
      this.applyZoom(tab);
      return;
    }

    if (this.syncFitViewport(tab)) {
      tab.generation += 1;
      tab.staleReason = "the viewport was resized";
      this.persist();
    }
    const debug = await this.ensureDebuggerOnly(tab);
    if (tab.view !== view) return;
    try {
      await this.syncViewport(tab, debug);
    } catch (error) {
      if (scaleFirst) place();
      throw error;
    }

    this.applyZoom(tab);
    if (this.needsColorScheme(tab)) await this.applyColorScheme(tab, debug);

    place();
  }

  applyBorderRadius(tab, view) {
    const radius = this.previewing(tab) ? 0 : this.radiusByScope.get(tab.scopeKey) || 0;
    if (tab.borderRadius === radius) return;
    tab.borderRadius = radius;
    view.setBorderRadius?.(radius);
  }

  applyCanvas(tab, view) {
    const canvas = tab.documentReady ? PAGE_CANVAS : NO_CANVAS;
    if (tab.canvas === canvas) return;
    tab.canvas = canvas;
    view.setBackgroundColor(canvas);
  }

  applyVisibility() {
    for (const tab of this.tabs) {
      if (!tab.view) continue;

      if (this.previewing(tab)) {
        this.applyGeometry(tab).catch(() => {});
        continue;
      }
      const active = tab.scopeKey === this.visibleScopeKey && tab.id === this.activeTabIds.get(tab.scopeKey);

      if (!active) tab.view.setVisible(false);
      this.applyGeometry(tab).catch(() => {});
    }
  }

  applyShownGeometry() {
    for (const tab of this.tabs) {
      if (tab.view && this.isTabShown(tab)) this.applyGeometry(tab).catch(() => {});
    }
  }

  setBounds(scopeKey, input) {
    const next = {
      x: Math.max(0, Math.round(Number(input?.x) || 0)),
      y: Math.max(0, Math.round(Number(input?.y) || 0)),
      width: Math.max(1, Math.round(Number(input?.width) || 1)),
      height: Math.max(1, Math.round(Number(input?.height) || 1)),
    };
    const scope = this.requireScope(scopeKey);
    this.boundsByScope.set(scope, next);

    this.radiusByScope.set(scope, Math.max(0, Math.round(Number(input?.radius) || 0)));

    if (this.visibleScopeKey && this.visibleScopeKey !== scope) return;
    const same = next.x === this.bounds.x && next.y === this.bounds.y && next.width === this.bounds.width && next.height === this.bounds.height;
    this.bounds = next;

    this.applyShownGeometry();
    if (!same && this.visibleScopeKey) this.scheduleBoundsEmit(this.visibleScopeKey);
  }

  async setVisible(scopeKey, visible) {
    const scope = this.requireScope(scopeKey);
    if (visible) {
      this.visibleScopeKey = scope;

      const own = this.boundsByScope.get(scope);
      if (own) this.bounds = own;
      for (const tab of this.scopeTabs(scope)) {
        if (!tab.destroyWhenIdle) this.cancelDeferredHibernate(tab);
      }
      const active = this.scopeTabs(scope).length ? this.activeTab(scope) : null;
      if (active) {
        try {
          await this.wakeTab(active);
        } catch {
        }
      }
    }
    else if (this.visibleScopeKey === scope) this.visibleScopeKey = null;

    await this.applyVisibilityAsync(scope);
  }

  async freezeView(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const frame = await this.captureFrozenFrame(scope);
    await this.setVisible(scopeKey, false);
    return frame;
  }

  async captureFrozenFrame(scope) {
    if (this.visibleScopeKey !== scope) return null;
    const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : null;
    if (!tab?.view || tab.view.webContents.isDestroyed?.()) return null;

    if (!this.isTabVisible(tab) || this.isBlank(tab) || this.previewing(tab)) return null;
    const rect = this.nativeRect(tab);

    const { width, height } = this.windowRect(rect);
    try {
      const image = await withTimeout(tab.view.webContents.capturePage({ x: 0, y: 0, width, height }), FREEZE_TIMEOUT_MS, FREEZE_TIMEOUT_MESSAGE);
      if (!image || image.isEmpty()) return null;
      return { data: image.toPNG().toString("base64"), mimeType: "image/png", rect };
    } catch {
      return null;
    }
  }

  async applyVisibilityAsync(scope) {
    this.applyVisibility();
    const activeId = this.activeTabIds.get(scope);
    const active = this.tabs.find((tab) => tab.scopeKey === scope && tab.id === activeId);

    if (active?.geometry) await active.geometry.queue;
  }

  hideVisibleScope() {
    const scope = this.visibleScopeKey;
    if (!scope) return;
    this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope);
  }

  tabWebPreferences(tab) {
    return {
      partition: tab.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,

      nodeIntegrationInSubFrames: true,

      preload: require("node:path").join(__dirname, "browser-tab-preload.js"),

      plugins: true,
    };
  }

  createViewForTab(tab) {
    this.preparePartition(tab.partition);
    return this.attachView(tab, this.createView({ webPreferences: this.tabWebPreferences(tab) }));
  }

  adoptViewForTab(tab, guest) {
    this.preparePartition(tab.partition);
    const view = guest
      ? this.createView({ webContents: guest })
      : this.createView({ webPreferences: this.tabWebPreferences(tab) });
    return this.attachView(tab, view);
  }

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
  }

  ensureViewport(tab) {
    return this.applyGeometry(tab);
  }

  forgetEmulation(tab) {
    tab.viewportOverride = undefined;
    tab.colorSchemeApplied = undefined;
  }

  devToolsEdge(tab) {
    this.forgetEmulation(tab);
    this.applyGeometry(tab).catch(() => {});
    this.emitState(tab.scopeKey);
  }

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
  }

  async readyHostForTab(tab, view) {
    const host = this.extensionHostFor(tab.partition);
    if (!host) return;
    if (typeof host.whenReady === "function") {
      try { await host.whenReady(); } catch {  }
    }

    if (tab.view === view && !view.webContents.isDestroyed()) host.addTab(view.webContents, this.window);
  }

  beginNavigation(tab) {
    tab.navigationPending += 1;
  }

  endNavigation(tab) {
    tab.navigationPending = Math.max(0, tab.navigationPending - 1);
    this.finishDeferredHibernate(tab);
  }

  async loadTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.beforeNavigation(tab);
      await this.loadAllowingReplacement(tab, url);
    } finally {
      this.endNavigation(tab);
    }
  }

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
  }

  async navigateTab(tab, url) {
    this.beginNavigation(tab);
    try {
      await this.wakeTab(tab);
      await this.loadTab(tab, normalizeUrl(url));
    } finally {
      this.endNavigation(tab);
    }
  }

  async goBack(tab) {
    const wc = tab.view.webContents;
    if (navigationFlag(wc, "canGoBack")) {
      await this.beforeNavigation(tab);
      wc.navigationHistory.goBack();
    }
  }

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
  }

  cancelDeferredHibernate(tab) {
    if (tab.hibernateTimer) clearTimeout(tab.hibernateTimer);
    tab.hibernateTimer = null;
    tab.hibernateWhenIdle = false;
    tab.destroyWhenIdle = false;
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  popupOpener(tab) {
    const recentAgentInput = this.now() - (this.lastAgentInputAt.get(tab.scopeKey) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
    return tab.agentBusy > 0 || recentAgentInput ? "agent" : "human";
  }

  trackPopupTab(task) {
    this.pendingPopupTabs.add(task);
    task.then(
      () => this.pendingPopupTabs.delete(task),
      () => this.pendingPopupTabs.delete(task),
    );
    return task;
  }

  async settlePopupTabs() {
    await Promise.allSettled([...this.pendingPopupTabs]);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  contentsOf(tab) {
    const wc = tab?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  devToolsOpen(tab) {
    const wc = this.contentsOf(tab);
    try {
      return Boolean(wc && wc.isDevToolsOpened && wc.isDevToolsOpened());
    } catch {
      return false;
    }
  }

  openDevTools(tab, inspectAt) {
    const wc = this.contentsOf(tab);
    if (!wc) return;
    try {
      if (!this.devToolsOpen(tab)) wc.openDevTools?.({ mode: "detach" });
      if (inspectAt) wc.inspectElement?.(Math.round(inspectAt.x || 0), Math.round(inspectAt.y || 0));
    } catch {
    }
  }

  closeDevTools(tab) {
    if (!this.devToolsOpen(tab)) return;
    try {
      this.contentsOf(tab)?.closeDevTools?.();
    } catch {
    }
  }

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
  }

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
  }

  endPreview(tab) {
    const win = tab?.previewWindow;
    if (!win) return;
    tab.previewWindow = null;
    this.reclaimView(tab);
    try { if (!win.isDestroyed?.()) win.destroy(); } catch {  }
  }

  reclaimView(tab) {
    if (!tab.view) return;
    try { this.window.contentView.addChildView(tab.view); } catch {  }
  }

  closePreview(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    this.endPreview(tab);
    this.applyVisibility();
    this.emitState(scope);
    return this.state(scope);
  }

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
  }

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
  }

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
  }

  openMenuTab(tab, url) {
    if (!url) return Promise.resolve(null);
    return this.trackPopupTab(this.createTab(tab.scopeKey, url, "human")).catch(() => null);
  }

  activeTab(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) =>
      candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope),
    );
    if (!tab) throw new Error("Open a browser tab before using browser controls.");
    return tab;
  }

  tabAt(scopeKey, index) {
    const tab = this.scopeTabs(scopeKey)[Number(index)];
    if (!tab) throw new Error(`Browser tab ${String(index)} does not exist.`);
    return tab;
  }

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
  }

  async focusAgentTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.agentTabIds.set(scope, tab.id);
    this.agentTabClosed.delete(scope);
    this.emitState(scope);
    return tab;
  }

  noteAgentTabClosed(tab) {
    if (this.agentTabIds.get(tab.scopeKey) !== tab.id) return;
    this.agentTabIds.delete(tab.scopeKey);
    this.agentTabClosed.set(tab.scopeKey, tab.title || tab.url || "untitled");
  }

  tabFor(scope, args) {
    return args && args.tabId !== undefined ? this.tabAt(scope, args.tabId) : this.agentTab(scope);
  }

  peekTarget(scope, args) {
    try {
      if (args && args.tabId !== undefined) return this.tabAt(scope, args.tabId);
      if (this.agentTabClosed.has(this.requireScope(scope))) return null;
      return this.tabFor(scope, args);
    } catch {
      return null;
    }
  }

  noteTabKeyFocus(tab, focused) {
    if (focused) {
      if (this.keyFocusedTabId === tab.id) return;
      this.keyFocusedTabId = tab.id;
    } else {
      if (this.keyFocusedTabId !== tab.id) return;
      this.keyFocusedTabId = null;
    }
    this.publishChordScope();
  }

  publishChordScope() {
    try {
      this.onChordScope(this.keyFocusedTabId ? TAB_SELECT_CHORDS : []);
    } catch {
    }
  }

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
  }

  async selectTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.activeTabIds.set(scope, tab.id);
    { const host = tab.view ? this.hostOfTab(tab) : null; if (host) host.selectTab(tab.view.webContents); }
    this.applyVisibility();
    this.emitState(scope);
  }

  closeTab(scopeKey, index, closedBy = "agent") {
    const scope = this.requireScope(scopeKey);
    return this.closeTabRef(index === undefined ? this.activeTab(scope) : this.tabAt(scope, index), closedBy);
  }

  closeTabRef(tab, closedBy = "agent") {
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
  }

  endBrowser(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.activeTabIds.delete(scope);
    this.boundsByScope.delete(scope);
    this.radiusByScope.delete(scope);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope, { ended: true });
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

  async ensureDebugger(tab, { sync = true } = {}) {
    const debug = tab.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    if (!tab.debuggerListenersBound) {
      debug.on("message", (_event, method, params) => {
        if (method === "Runtime.consoleAPICalled") {
          const text = logText((params.args || []).map((arg) => logText(arg.value ?? arg.description ?? "")).join(" "));
          pushCapped(tab.console, { level: params.type || "log", text });
        }
        if (method === "Log.entryAdded") {
          pushCapped(tab.console, { level: params.entry?.level || "info", text: logText(params.entry?.text || "") });
        }
        if (method === "Network.requestWillBeSent") {
          pushCapped(tab.network, { method: params.request?.method || "GET", url: logText(params.request?.url || "") });
        }
      });
      debug.on("detach", () => {
        if (tab.view?.webContents?.debugger !== debug) return;
        tab.debuggerReady = false;

        this.forgetEmulation(tab);
      });
      tab.debuggerListenersBound = true;
    }
    if (!tab.debuggerReady) {
      await Promise.all([
        debug.sendCommand("DOM.enable"),
        debug.sendCommand("Runtime.enable"),
        debug.sendCommand("Accessibility.enable"),
        debug.sendCommand("Network.enable"),
        debug.sendCommand("Log.enable"),
        debug.sendCommand("Page.enable"),
      ]);
      tab.debuggerReady = true;
    }

    if (sync) await this.applyGeometry(tab);
    return debug;
  }

  async syncViewport(tab, debug) {
    const target = this.viewportTarget(tab);
    if (!target.emulate) {
      if (tab.viewportOverride === undefined || tab.viewportOverride === "native") { tab.viewportOverride = "native"; return; }
      await debug.sendCommand("Emulation.clearDeviceMetricsOverride");
      tab.viewportOverride = "native";
      return;
    }
    const wanted = emulationKey(target);
    if (tab.viewportOverride === wanted) return;

    await debug.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: target.width,
      height: target.height,
      deviceScaleFactor: target.deviceScaleFactor || 1,
      mobile: false,
      ...(target.scale === 1 ? {} : { scale: target.scale }),
      ...(target.view ? { dontSetVisibleSize: true } : {}),
    });
    if (target.view) await debug.sendCommand("Emulation.setVisibleSize", target.view);
    tab.viewportOverride = wanted;
  }

  applyZoom(tab) {
    const wc = this.contentsOf(tab);
    if (!wc?.setZoomFactor) return;
    try { wc.setZoomFactor(tab.zoom || 1); } catch {  }
  }

  needsColorScheme(tab) {
    const wanted = tab.colorScheme || "system";
    if (tab.colorSchemeApplied === wanted) return false;
    return !(wanted === "system" && tab.colorSchemeApplied === undefined);
  }

  async applyColorScheme(tab, debug) {
    const wanted = tab.colorScheme || "system";
    await debug.sendCommand("Emulation.setEmulatedMedia", {
      features: wanted === "system" ? [] : [{ name: "prefers-color-scheme", value: wanted }],
    });
    tab.colorSchemeApplied = wanted;
  }

  viewportTarget(tab) {
    if (this.isNativeFit(tab)) {
      const stage = this.stageBounds();
      return { emulate: false, width: stage.width, height: stage.height, scale: 1 };
    }
    const viewport = this.viewportOf(tab);

    if (!this.isTabVisible(tab)) return { emulate: true, width: viewport.width, height: viewport.height, scale: 1 };
    const scale = fitViewport(viewport, this.bounds, this.zoomOf(tab)).scale * this.cockpitZoom();

    const native = this.windowRect(this.nativeRect(tab));

    const deviceScaleFactor = this.deviceScaleFactor();
    return { emulate: true, width: viewport.width, height: viewport.height, scale, deviceScaleFactor, view: { width: native.width, height: native.height } };
  }

  inputPoint(tab, point) {
    const { scale } = this.viewportTarget(tab);
    return scale === 1 ? point : { ...point, x: point.x * scale, y: point.y * scale };
  }

  async beforeNavigation(tab) {
    if (!tab.view || !tab.debuggerReady || !tab.viewportOverride) return;
    tab.viewportOverride = undefined;
    try {
      await tab.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    } catch {
    }
  }

  captureIntrinsic(debug, tab, format, fullPage, documentHeight) {
    const viewport = this.effectiveViewport(tab);

    const ratio = this.viewportTarget(tab).deviceScaleFactor || 1;
    return debug.sendCommand("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: viewport.width, height: fullPage && documentHeight ? documentHeight : viewport.height, scale: 1 / ratio },
    });
  }

  resyncViewports() {
    this.applyVisibility();
  }

  async snapshot(tab, args = {}) {
    const debug = await this.ensureDebugger(tab);
    const target = String(args.target || "").trim();
    const backendNodeId = target ? tab.refs.get(target) : undefined;
    if (target && !backendNodeId) {
      throw new Error(`Unknown browser target ${target}. Take a fresh browser_snapshot first.`);
    }
    const result = await debug.sendCommand("Accessibility.getFullAXTree", { depth: 40 });
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    let rootNodeId = null;
    if (backendNodeId) {
      const root = nodes.find((node) => Number(node.backendDOMNodeId || 0) === backendNodeId);
      if (!root) throw new Error(`${target} is no longer on the page. Take a fresh browser_snapshot first.`);
      rootNodeId = root.nodeId;
    }
    const maxDepth = Number.isInteger(args.depth) && args.depth >= 0 ? args.depth : null;
    const rendered = renderSnapshot(nodes, { title: tab.title, url: tab.url, rootNodeId, maxDepth });
    tab.refs.clear();
    for (const [ref, id] of rendered.refs) tab.refs.set(ref, id);
    return okText(rendered.text);
  }

  backendNode(tab, target) {
    const ref = String(target || "").trim();
    const backendNodeId = tab.refs.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown browser target ${ref || "(empty)"}. Take a fresh browser_snapshot first.`);
    }
    return backendNodeId;
  }

  async callOnNode(tab, backendNodeId, functionDeclaration, args = []) {
    const debug = await this.ensureDebugger(tab);
    const resolved = await debug.sendCommand("DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected element is no longer available. Take a fresh snapshot.");
    return debug.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async targetPoint(tab, target) {
    const backendNodeId = this.backendNode(tab, target);
    const result = await this.callOnNode(
      tab,
      backendNodeId,
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height}; }",
    );
    const point = result.result?.value;
    if (!point || point.width <= 0 || point.height <= 0) throw new Error("The selected element is not visible.");
    return { backendNodeId, x: point.x, y: point.y };
  }

  async showAgentCursor(tab, point, phase) {
    const debug = await this.ensureDebugger(tab);
    const payload = JSON.stringify({ ...point, phase, duration: CURSOR_MOVE_MS });
    await debug.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const data = ${payload};
        let root = document.getElementById('__telar_agent_cursor__');
        if (!root) {
          root = document.createElement('div');
          root.id = '__telar_agent_cursor__';
          root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;opacity:0;transition:transform 160ms cubic-bezier(.22,1,.36,1),opacity 90ms ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';
          root.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3.5 19 13l-6.2 1.2 3.4 5.6-2.8 1.7-3.3-5.6L6 20z" fill="#fff" stroke="#2563eb" stroke-width="1.8" stroke-linejoin="round"/></svg>';
          document.documentElement.appendChild(root);
        }
        root.style.opacity = '1';
        root.style.transform = 'translate3d(' + data.x + 'px,' + data.y + 'px,0)';
        clearTimeout(window.__telarAgentCursorTimer);
        window.__telarAgentCursorTimer = setTimeout(() => {
          root.style.opacity = '0.38';
          window.__telarAgentCursorTimer = setTimeout(() => {
            root.style.opacity = '0';
          }, 6000);
        }, 2200);
        if (data.phase === 'click') {
          const ring = document.createElement('span');
          ring.style.cssText = 'position:absolute;left:-7px;top:-7px;width:24px;height:24px;border-radius:999px;background:rgba(37,99,235,.22);animation:__telar_cursor_ping 360ms ease-out forwards';
          if (!document.getElementById('__telar_cursor_style__')) {
            const style = document.createElement('style');
            style.id = '__telar_cursor_style__';
            style.textContent = '@keyframes __telar_cursor_ping{from{transform:scale(.35);opacity:1}to{transform:scale(1.8);opacity:0}}';
            document.documentElement.appendChild(style);
          }
          root.prepend(ring);
          setTimeout(() => ring.remove(), 450);
        }
      })()`,
    });
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:pointer", {
        scopeKey: tab.scopeKey,
        tabId: tab.id,
        phase,
        x: point.x,
        y: point.y,
        createdAt: new Date().toISOString(),
      });
    }
  }

  coordinatesOf(tab, args) {
    const hasTarget = String(args.target ?? "").trim() !== "";
    const hasX = args.x !== undefined && args.x !== null;
    const hasY = args.y !== undefined && args.y !== null;
    if (hasTarget && (hasX || hasY)) throw new Error("Pass either a target from browser_snapshot or x and y from browser_take_screenshot, not both.");
    if (hasTarget) return null;
    if (!hasX && !hasY) throw new Error("Pass a target from browser_snapshot, or x and y in the CSS pixels of browser_take_screenshot's image.");
    return this.viewportPoint(tab, args.x, args.y);
  }

  viewportPoint(tab, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y go together: pass both, as numbers in the CSS pixels of browser_take_screenshot's image.");
    const point = { x, y };
    const viewport = this.effectiveViewport(tab);
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`${pointText(point)} is outside the ${viewport.width}×${viewport.height} viewport of the screenshot. Scroll or resize, then take a fresh screenshot.`);
    }
    return point;
  }

  async evaluateInPage(tab, fn, args = []) {
    const debug = await this.ensureDebugger(tab);
    const result = await debug.sendCommand("Runtime.evaluate", {
      expression: `(${fn})(${args.map((value) => JSON.stringify(value)).join(", ")})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "an error";
      throw new Error(`The page threw while Telar read it (${String(detail).split("\n")[0]}). Take a fresh screenshot and try again.`);
    }
    return result?.result?.value;
  }

  async labelAt(tab, point) {
    try {
      const described = await this.evaluateInPage(tab, PAGE_AT_POINT, [point.x, point.y]);
      return described?.role ? `: ${pageLabel(described)}` : "";
    } catch {
      return "";
    }
  }

  async focusedEditable(tab) {
    return (await this.evaluateInPage(tab, PAGE_FOCUSED_EDITABLE)) || null;
  }

  async click(tab, args, action) {
    const at = this.coordinatesOf(tab, args);

    const label = at ? await this.labelAt(tab, at) : "";
    const point = at || await this.targetPoint(tab, args.target);
    await this.showAgentCursor(tab, point, "move");
    await this.wait(CURSOR_MOVE_MS);
    await this.showAgentCursor(tab, point, "click");
    await this.wait(CURSOR_CLICK_LEAD_MS);
    const debug = await this.ensureDebugger(tab);
    const button = args.button || "left";
    const clickCount = args.doubleClick ? 2 : 1;
    if (action) this.checkpoint(action);

    this.stampAgentInput(tab, clickCount);
    const native = this.inputPoint(tab, point);
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: native.x, y: native.y });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: native.x, y: native.y, button, clickCount });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: native.x, y: native.y, button, clickCount });
    return okText(at ? `Clicked at ${pointText(at)}${label}.` : `Clicked ${args.element || args.target}.`);
  }

  async hover(tab, args) {
    const at = this.coordinatesOf(tab, args);
    const label = at ? await this.labelAt(tab, at) : "";
    const point = at || await this.targetPoint(tab, args.target);
    await this.showAgentCursor(tab, point, "move");
    const debug = await this.ensureDebugger(tab);
    this.stampAgentInput(tab);
    const native = this.inputPoint(tab, point);
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: native.x, y: native.y });
    return okText(at ? `Hovered at ${pointText(at)}${label}.` : `Hovered ${args.element || args.target}.`);
  }

  async drag(tab, args, action) {
    const values = [args.x, args.y, args.toX, args.toY];
    if (values.some((value) => value === undefined || value === null)) {
      throw new Error("browser_drag needs x, y, toX and toY in the CSS pixels of browser_take_screenshot's image.");
    }
    const from = this.viewportPoint(tab, args.x, args.y);
    const to = this.viewportPoint(tab, args.toX, args.toY);
    await this.showAgentCursor(tab, from, "move");
    await this.wait(CURSOR_MOVE_MS);
    const debug = await this.ensureDebugger(tab);
    const mouse = (type, point, extra = {}) => {
      const native = this.inputPoint(tab, point);
      return debug.sendCommand("Input.dispatchMouseEvent", { type, x: native.x, y: native.y, ...extra });
    };
    if (action) this.checkpoint(action);

    this.stampAgentInput(tab, 1);
    await mouse("mouseMoved", from);
    await mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
    const steps = 5;
    for (let step = 1; step <= steps; step += 1) {
      const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
      await mouse("mouseMoved", point, { button: "left", buttons: 1 });
    }
    await mouse("mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
    await this.showAgentCursor(tab, to, "move");
    return okText(`Dragged from ${pointText(from)} to ${pointText(to)}.`);
  }

  async type(tab, args, action) {
    if (String(args.target ?? "").trim() === "") return this.typeAtFocus(tab, args, action);
    const backendNodeId = this.backendNode(tab, args.target);
    if (action) this.checkpoint(action);
    await this.callOnNode(
      tab,
      backendNodeId,
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); if ('value' in this) { this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); } }",
    );
    await this.insertText(tab, String(args.text ?? ""), args.slowly, action);
    if (args.submit) await this.press(tab, { key: "Enter" }, action);
    return okText(`Typed into ${args.element || args.target}.`);
  }

  async typeAtFocus(tab, args, action) {
    const focused = await this.focusedEditable(tab);
    if (!focused) {
      throw new Error("Nothing editable has focus in this tab. Click into a field or a cell first (a spreadsheet's name box or formula bar), or pass a target.");
    }
    await this.insertText(tab, String(args.text ?? ""), args.slowly, action);
    if (args.submit) await this.press(tab, { key: "Enter" }, action);
    return okText(`Typed into the focused ${pageLabel(focused)}.`);
  }

  async insertText(tab, text, slowly, action) {
    const debug = await this.ensureDebugger(tab);
    if (slowly) {
      for (const char of text) {
        if (action) this.checkpoint(action);
        this.stampAgentInput(tab);
        await debug.sendCommand("Input.insertText", { text: char });
        await this.wait(15);
      }
    } else {
      if (action) this.checkpoint(action);
      this.stampAgentInput(tab);
      await debug.sendCommand("Input.insertText", { text });
    }
  }

  async press(tab, args, action) {
    const key = String(args.key || "");
    if (!key) throw new Error("A key is required.");
    const { keyCode, modifiers } = keyChord(key);
    if (action) this.checkpoint(action);

    this.stampAgentInput(tab, 1);
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    return okText(`Pressed ${key}.`);
  }

  async paste(tab, args, action) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) throw new Error("browser_paste needs the text to paste.");
    const count = Array.from(text).length;
    if (action) this.checkpoint(action);

    this.stampAgentInput(tab);
    const outcome = (await this.evaluateInPage(tab, PAGE_PASTE, [text])) || {};
    if (outcome.handled) return okText(`Pasted ${count} characters; the page handled the paste event.`);
    if (!outcome.editable) {
      throw new Error("Nothing took the paste: nothing editable has focus and the page did not handle a paste event. Click into a cell or field first.");
    }
    await this.insertText(tab, text, false, action);
    return okText(`Inserted ${count} characters at the focused ${pageLabel(outcome.editable)}; the page did not handle a paste event.`);
  }

  async copy(tab, action) {
    if (action) this.checkpoint(action);
    this.stampAgentInput(tab);
    const text = await this.evaluateInPage(tab, PAGE_COPY);
    if (typeof text !== "string" || !text) throw new Error("Nothing is selected in this tab. Select text or cells first.");
    return okText(capCopied(text));
  }

  async fillForm(tab, args, action) {
    for (const field of Array.isArray(args.fields) ? args.fields : []) {
      const backendNodeId = this.backendNode(tab, field.target);
      if (field.type === "checkbox" || field.type === "radio") {
        const checked = /^(true|1|yes|on)$/i.test(String(field.value));
        if (action) this.checkpoint(action);
        await this.callOnNode(tab, backendNodeId, "function(value){ if (this.checked !== value) this.click(); }", [checked]);
      } else if (field.type === "combobox") {
        await this.selectOption(tab, { target: field.target, values: [field.value] }, action);
      } else {
        await this.type(tab, { target: field.target, element: field.element || field.name, text: field.value }, action);
      }
    }
    return okText("Filled the requested form fields.");
  }

  async selectOption(tab, args, action) {
    const backendNodeId = this.backendNode(tab, args.target);
    if (action) this.checkpoint(action);
    await this.callOnNode(
      tab,
      backendNodeId,
      "function(values){ const wanted=new Set(values.map(String)); for (const option of this.options || []) option.selected=wanted.has(option.value)||wanted.has(option.text); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); }",
      [Array.isArray(args.values) ? args.values : []],
    );
    return okText(`Selected an option in ${args.element || args.target}.`);
  }

  async screenshot(tab, args) {
    const debug = await this.ensureDebugger(tab);
    const format = args.type === "jpeg" ? "jpeg" : "png";
    const fullPage = Boolean(args.fullPage);
    const data = this.isTabVisible(tab)
      ? await withTimeout(
          (async () => {
            const documentHeight = fullPage ? await this.measureDocument(debug).then((metrics) => metrics.height) : undefined;
            return (await this.captureIntrinsic(debug, tab, format, fullPage, documentHeight)).data;
          })(),
          CAPTURE_TIMEOUT_MS,
          CAPTURE_TIMEOUT_MESSAGE,
        )
      : await this.captureHidden(tab, debug, format, fullPage);
    return { content: [{ type: "image", data, mimeType: `image/${format}` }] };
  }

  async measureDocument(debug) {
    const { result } = await debug.sendCommand("Runtime.evaluate", {
      expression: "({ width: Math.ceil(Math.max(document.documentElement.scrollWidth, innerWidth)), height: Math.ceil(Math.max(document.documentElement.scrollHeight, innerHeight)) })",
      returnByValue: true,
    });
    const metrics = result?.value;
    if (!metrics || !(metrics.width > 0 && metrics.height > 0)) throw new Error("Could not measure the page for a full-page capture.");
    return metrics;
  }

  async captureHidden(tab, debug, format, fullPage) {
    const wc = tab.view.webContents;
    let metrics = null;
    if (fullPage) {
      metrics = await this.measureDocument(debug);

      await debug.sendCommand("Emulation.setDeviceMetricsOverride", { width: metrics.width, height: metrics.height, deviceScaleFactor: 1, mobile: false });
    }
    try {
      const image = await withTimeout(wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), CAPTURE_TIMEOUT_MS, CAPTURE_TIMEOUT_MESSAGE);
      if (image.isEmpty()) throw new Error("The hidden page produced an empty frame.");
      return (format === "jpeg" ? image.toJPEG(80) : image.toPNG()).toString("base64");
    } finally {
      if (metrics) {
        tab.viewportOverride = undefined;
        await this.applyGeometry(tab).catch(() => {});
      }
    }
  }

  async capture(scopeKey, options = {}) {
    const scope = this.requireScope(scopeKey);
    if (!this.scopeTabs(scope).length) throw new Error("There is no page here to capture.");
    const tab = await this.wakeTab(this.activeTab(scope));

    if (isProtectedUrl(tab.url)) throw new Error("That tab is showing an extension page. Telar does not capture extension pages.");
    if (this.isBlank(tab)) throw new Error("There is no page loaded in this tab to capture.");
    const fullPage = Boolean(options.fullPage);
    const outcome = await this.screenshot(tab, { type: "png", fullPage });
    const image = outcome.content?.find((entry) => entry.type === "image");
    if (!image?.data) throw new Error("The page produced no frame to capture.");
    const viewport = this.effectiveViewport(tab);
    return {
      data: image.data,
      mimeType: image.mimeType,
      url: tab.url,
      title: tab.title,
      fullPage,
      width: viewport.width,
      height: viewport.height,
      ...(options.elements ? { elements: await this.elementBoxes(tab) } : {}),
    };
  }

  async elementBoxes(tab) {
    const debug = await this.ensureDebugger(tab);
    const { result } = await debug.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const selectorFor = (el) => {
          if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
          const parts = [];
          for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
            const tag = node.localName;
            if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
            const siblings = node.parentElement ? [...node.parentElement.children].filter((other) => other.localName === tag) : [tag];
            parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
          }
          return parts.join(' > ');
        };
        const nameOf = (el) => (
          el.getAttribute('aria-label') ||
          (el.labels && el.labels[0] && el.labels[0].textContent) ||
          el.getAttribute('alt') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          (el.value && typeof el.value === 'string' ? el.value : '') ||
          el.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim().slice(0, 120);
        const roleOf = (el) => el.getAttribute('role') || el.localName;
        const boxes = [];
        for (const el of document.body ? document.body.querySelectorAll('*') : []) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          boxes.push({
            role: roleOf(el),
            name: nameOf(el),
            selector: selectorFor(el),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
          if (boxes.length >= 1500) break;
        }
        return boxes.sort((a, b) => a.width * a.height - b.width * b.height);
      })()`,
      returnByValue: true,
    });
    return Array.isArray(result?.value) ? result.value : [];
  }

  isBlank(tab) {
    const url = tab.view && !tab.view.webContents.isDestroyed?.() ? tab.view.webContents.getURL() || tab.url : tab.url;
    return (!url || url === "about:blank") && !tab.loading && tab.navigationPending === 0;
  }

  previewing(tab) {
    return Boolean(tab?.previewWindow && !tab.previewWindow.isDestroyed?.());
  }

  previewRect(tab) {
    const [width, height] = tab.previewWindow?.getContentSize?.() || [];
    const viewport = this.viewportOf(tab);
    return { x: 0, y: 0, width: Math.max(1, Math.round(width || viewport.width)), height: Math.max(1, Math.round(height || viewport.height)) };
  }

  isTabShown(tab) {
    if (this.previewing(tab)) return false;
    return tab.scopeKey === this.visibleScopeKey && tab.id === this.activeTabIds.get(tab.scopeKey);
  }

  isTabVisible(tab) {
    return this.isTabShown(tab) && this.bounds.width > 1 && this.bounds.height > 1;
  }

  listTabs(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    if (!tabs.length) return okText("No browser tabs are open in this session.");
    const activeTabId = this.activeTabIds.get(scope);

    const agentTabId = this.peekTarget(scope, {})?.id;

    return okText(
      tabs
        .map((tab, index) => {
          const meta = [`tab=${tab.id}`, `controller=${this.tabActivity(tab)}`, `opened-by=${tab.openedBy || "agent"}`];

          if (tab.profileId) {
            meta.push(`profile=${tab.profileId}`);
            const profile = this.profiles.get(tab.profileId);
            if (profile) meta.push(`profile-label=${encodeURIComponent(profile.label)}`);
          }

          if (tab.id === agentTabId) meta.push("yours");
          if (tab.loading) meta.push("loading");
          if (isProtectedUrl(tab.url)) { meta.push("extension-page"); return `- ${index}: ${tab.id === activeTabId ? "(current) " : ""}[Extension page](about:blank) {${meta.join(", ")}}`; }
          return `- ${index}: ${tab.id === activeTabId ? "(current) " : ""}[${tab.title}](${tab.url}) {${meta.join(", ")}}`;
        })
        .join("\n"),
    );
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

module.exports = { DesktopBrowserManager, managerForScope, keyChord, createExternalLinkPolicy, externalOpenTarget, normalizeUrl, looksLikeAddress, SEARCH_URL, TAB_SELECT_CHORDS, resolveViewport, resolveZoom, fitViewport, zoomStep, DEFAULT_VIEWPORT, VIEWPORT_PRESETS, ZOOM_STEPS, renderSnapshot, renderConsole, renderNetwork, MAX_LOG_ITEMS, MAX_LOG_TEXT };
