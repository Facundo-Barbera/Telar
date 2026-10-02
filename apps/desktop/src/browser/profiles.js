const { requireProjectKey } = require("./browser-profiles");
const { pushCapped } = require("./render");
const { PERMISSION_KINDS } = require("./site-permissions");

module.exports = {
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
  },

  setScopeProfile(scopeKey, profileId) {
    const scope = this.requireScope(scopeKey);
    const profile = this.profiles.require(profileId);
    this.scopeProfileOverrides.set(scope, profile.id);
    this.scopeProfiles.set(scope, profile.id);
    this.persist();
    this.emitState(scope);
    return this.describeProfileBinding(scope, profile, this.scopeProjects.get(scope) ?? null);
  },

  describeProfileBinding(scope, profile, projectKey) {
    return {
      scopeKey: scope,

      profileKey: projectKey,
      profileId: profile.id,
      label: profile.label,
      ...(profile.account ? { account: profile.account } : {}),
      partition: profile.partition,
    };
  },

  drainProfileMigrations() {
    if (!this.profiles.migrations.length) return;
    const moves = this.profiles.migrations.splice(0, this.profiles.migrations.length);
    if (!this.onProfileMigrated) return;
    for (const move of moves) {
      try { this.onProfileMigrated(move.from, move.to); } catch {  }
    }
  },

  profileOf(scopeKey) {
    return this.scopeProjects.get(this.requireScope(scopeKey)) || null;
  },

  activeProfile(scopeKey) {
    const id = this.scopeProfiles.get(this.requireScope(scopeKey));
    return id ? this.profiles.get(id) : null;
  },

  partitionOf(scopeKey) {
    const profile = this.activeProfile(scopeKey);
    if (!profile) throw new Error(`Browser session ${this.requireScope(scopeKey)} is not bound to a project profile yet; nothing can open until it is.`);
    return profile.partition;
  },

  listProfiles() {
    return this.profiles.list().map((profile) => ({
      ...profile,
      projects: this.profiles.projectsOf(profile.id),
      sessions: this.scopesUsing(profile.id).size,
    }));
  },

  scopesUsing(profileId) {
    const scopes = new Set();
    for (const [scope, bound] of this.scopeProfiles) if (bound === profileId) scopes.add(scope);
    for (const tab of this.tabs) if (tab.profileId === profileId) scopes.add(tab.scopeKey);
    return scopes;
  },

  deleteProfile(profileId) {
    const removed = this.profiles.remove(profileId);
    const fallback = this.profiles.require(this.profiles.defaultProfileId);
    const scopes = this.scopesUsing(removed.id);
    for (const scope of scopes) {
      if (this.scopeProfiles.get(scope) !== removed.id) continue;
      this.scopeProfileOverrides.delete(scope);
      this.scopeProfiles.set(scope, fallback.id);
    }
    let tabs = 0;
    for (const tab of this.tabs) {
      if (tab.profileId !== removed.id) continue;
      this.hibernateTab(tab);
      tab.profileId = fallback.id;
      tab.partition = fallback.partition;
      tabs += 1;
    }
    this.profiles.eraseData(removed.partition);
    this.persist();
    return { ...removed, sessions: scopes.size, tabs };
  },

  extensionHostFor(partition) {
    let host = this.extensionHosts.get(partition) || null;
    if (!host && this.createExtensionHost) {
      host = this.createExtensionHost(partition);
      if (host) this.extensionHosts.set(partition, host);
    }
    return host;
  },

  hostOfTab(tab) {
    return this.extensionHosts.get(tab.partition) || null;
  },

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
  },

  activePartitions() {
    return new Set([
      ...this.preparedPartitions,
      ...this.extensionHosts.keys(),
      ...this.tabs.map((tab) => tab.partition).filter(Boolean),
    ]);
  },

  hostForScope(scopeKey) {
    let partition;
    try { partition = this.partitionOf(scopeKey); } catch { return null; }
    return this.extensionHostFor(partition);
  },

  attachExtensionHost(host, partition) {
    if (!partition) throw new Error("attachExtensionHost needs the partition the host serves.");
    this.extensionHosts.set(partition, host);
    for (const tab of this.tabs) if (tab.view && tab.partition === partition) host.addTab(tab.view.webContents, this.window);
  },

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
  },

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
  },

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
  },

  deliverPermissionPrompt(record) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-request", record);
  },

  answerSitePermission(requestId, answer) {
    return { answered: this.permissionPrompts.answer(requestId, answer || {}) };
  },

  pendingPermissionPrompts(scopeKey) {
    return scopeKey ? this.permissionPrompts.pending(this.requireScope(scopeKey)) : this.permissionPrompts.pending();
  },

  scopeSitePermissions(scopeKey, origin) {
    const partition = this.partitionOf(scopeKey);
    return origin
      ? { partition, origin, kinds: this.sitePermissions.listOrigin(partition, origin) }
      : { partition, origins: this.sitePermissions.list(partition) };
  },

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
  },

  forgetSitePermission({ partition, scopeKey, origin, kind } = {}) {
    const jar = partition || this.partitionOf(scopeKey);
    if (!origin) throw new Error("Forgetting a site permission needs the origin it was given to.");
    this.sitePermissions.forget(jar, origin, kind === undefined || kind === null ? undefined : kind);
    return this.listSitePermissions();
  },

  reportPermissionDenied(context) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("telar:browser:permission-denied", { origin: context.origin, kinds: context.kinds, reason: context.reason });
  },
};
