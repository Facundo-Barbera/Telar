const fs = require("node:fs");
const path = require("node:path");
const { isProtectedUrl } = require("./protected-urls");

const INVENTORY_VERSION = 2;
const FILE_NAME = "browser-tabs.json";
const MAX_TABS_PER_SCOPE = 12;
const MAX_TEXT = 2_000;

function cleanText(value, fallback = "") {
  const text = typeof value === "string" ? value : "";
  return (text || fallback).slice(0, MAX_TEXT);
}

function rememberableUrl(value) {
  const url = cleanText(value, "about:blank");
  if (url === "about:blank") return url;
  if (isProtectedUrl(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function cleanViewport(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (!(width >= 200 && width <= 5_000 && height >= 200 && height <= 5_000)) return undefined;
  return { width, height };
}

function serializeInventory({ tabs, profiles, projects, overrides, active }) {
  const scopes = {};
  for (const tab of tabs) {
    const profileId = profiles.get(tab.scopeKey);
    if (!profileId) continue;
    const url = rememberableUrl(tab.url);
    if (url === null) continue;
    const scope = (scopes[tab.scopeKey] ||= {
      profileId,
      ...(projects?.get(tab.scopeKey) ? { projectKey: projects.get(tab.scopeKey) } : {}),
      ...(overrides?.get(tab.scopeKey) ? { overridden: true } : {}),
      activeTabId: null,
      tabs: [],
    });
    if (scope.tabs.length >= MAX_TABS_PER_SCOPE) continue;
    scope.tabs.push({
      id: tab.id,
      url,
      title: cleanText(tab.title, "New tab"),
      openedBy: tab.openedBy === "human" ? "human" : "agent",
      ...(tab.profileId ? { profileId: tab.profileId } : {}),
      ...(tab.viewport === undefined ? {} : { viewport: tab.viewport }),
      ...(tab.viewportMode === "fit" || tab.viewportMode === "fixed" ? { viewportMode: tab.viewportMode } : {}),
    });
  }
  for (const [scopeKey, scope] of Object.entries(scopes)) {
    const wanted = active.get(scopeKey);
    scope.activeTabId = scope.tabs.some((tab) => tab.id === wanted) ? wanted : (scope.tabs.at(-1)?.id ?? null);
  }
  return { version: INVENTORY_VERSION, savedAt: Date.now(), scopes };
}

function parseInventory(document, registry) {
  const scopes = [];
  if (!document || typeof document !== "object") return scopes;
  const version = document.version;
  if (version !== INVENTORY_VERSION && version !== 1) return scopes;
  const raw = document.scopes && typeof document.scopes === "object" ? document.scopes : {};
  for (const [scopeKey, scope] of Object.entries(raw)) {
    if (!scopeKey.trim() || !scope || typeof scope !== "object") continue;
    let profile = null;
    let projectKey = cleanText(scope.projectKey) || null;
    try {
      if (version === 1) {
        projectKey = cleanText(scope.profileKey);
        profile = registry.resolve(projectKey);
      } else {
        profile = registry.require(cleanText(scope.profileId));
      }
    } catch {
      continue;
    }
    const seen = new Set();
    const tabs = [];
    for (const tab of Array.isArray(scope.tabs) ? scope.tabs : []) {
      if (!tab || typeof tab !== "object") continue;
      const id = cleanText(tab.id);
      const url = rememberableUrl(tab.url);
      if (!id || url === null || seen.has(id)) continue;
      seen.add(id);
      const viewport = cleanViewport(tab.viewport);

      const tabProfileId = cleanText(tab.profileId);
      tabs.push({
        id,
        url,
        title: cleanText(tab.title, "New tab"),
        openedBy: tab.openedBy === "human" ? "human" : "agent",
        ...(tabProfileId && registry.get(tabProfileId) ? { profileId: tabProfileId } : {}),
        ...(viewport === undefined ? {} : { viewport }),

        ...(tab.viewportMode === "fit" || tab.viewportMode === "fixed" ? { viewportMode: tab.viewportMode } : {}),
      });
      if (tabs.length >= MAX_TABS_PER_SCOPE) break;
    }
    if (!tabs.length) continue;
    const activeTabId = tabs.some((tab) => tab.id === scope.activeTabId) ? scope.activeTabId : tabs.at(-1).id;
    scopes.push({
      scopeKey,
      profile,
      ...(projectKey ? { projectKey } : {}),
      overridden: scope.overridden === true,
      activeTabId,
      tabs,
    });
  }
  return scopes;
}

function createTabStore(userDataDir, { fsImpl = fs, writeDelayMs = 150, setTimer = setTimeout } = {}) {
  const file = path.join(userDataDir, FILE_NAME);
  let pending = null;
  let timer = null;
  let inFlight = Promise.resolve();
  let idle = Promise.resolve();
  let resolveIdle = null;

  let revision = 0;
  let landed = 0;
  let lastError = null;

  function settleIdle() {
    if (resolveIdle) { resolveIdle(); resolveIdle = null; }
  }

  function writeNow() {
    const document = pending;
    pending = null;
    timer = null;
    if (!document) return;
    const rev = document.revision;
    inFlight = inFlight.then(async () => {
      fsImpl.mkdirSync(userDataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${rev}.tmp`;
      try {
        await fsImpl.promises.writeFile(tmp, JSON.stringify(document.value), "utf8");

        if (landed > rev) return;
        fsImpl.renameSync(tmp, file);
        landed = Math.max(landed, rev);
      } finally {
        try { fsImpl.unlinkSync(tmp); } catch {  }
      }
    }).catch((error) => {
      lastError = error;
      console.error(`[telar-desktop] could not save the browser tab inventory: ${error && error.message ? error.message : error}`);
    }).then(() => {
      if (pending) writeNow();
      else settleIdle();
    });
  }

  return {
    file,
    load() {
      try {
        return JSON.parse(fsImpl.readFileSync(file, "utf8"));
      } catch (error) {
        if (error && error.code !== "ENOENT") console.error(`[telar-desktop] ignoring an unreadable browser tab inventory: ${error.message}`);
        return null;
      }
    },
    save(document) {
      pending = { value: document, revision: ++revision };
      if (!resolveIdle) idle = new Promise((resolve) => { resolveIdle = resolve; });
      if (!timer) timer = setTimer(writeNow, writeDelayMs);
    },

    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending) writeNow();
      return resolveIdle ? idle : inFlight;
    },

    flushSync(document) {
      if (timer) { clearTimeout(timer); timer = null; }
      const chosen = document !== undefined ? { value: document, revision: ++revision } : pending;
      pending = null;
      if (!chosen) return;
      try {
        fsImpl.mkdirSync(userDataDir, { recursive: true });
        const tmp = `${file}.${process.pid}.${chosen.revision}.sync.tmp`;
        fsImpl.writeFileSync(tmp, JSON.stringify(chosen.value), "utf8");
        fsImpl.renameSync(tmp, file);
        landed = Math.max(landed, chosen.revision);
      } catch (error) {
        lastError = error;
        console.error(`[telar-desktop] could not save the browser tab inventory at quit: ${error && error.message ? error.message : error}`);
      }

      settleIdle();
    },

    get lastError() { return lastError; },
  };
}

module.exports = { createTabStore, serializeInventory, parseInventory, rememberableUrl, INVENTORY_VERSION };
