/**
 * THE PERSISTED TAB INVENTORY — what the integrated browser remembers across a
 * renderer reload, a window rebuild and an app restart.
 *
 * SCOPED METADATA ONLY. Per scope (a session): its declared project profile,
 * the ordered tabs (id, url, title, who opened it, its viewport) and which is
 * active. Nothing else: no cookies (the partition on disk owns those), no
 * console/network logs, no snapshot refs, no page content. Extension pages
 * (chrome-extension://) and anything that is not http(s)/about:blank are
 * dropped at serialization AND at parse, so the credential UI never lands in
 * this file and a hand-edited file cannot smuggle one back in.
 *
 * THE PARTITION IS NOT PERSISTED — it is recomputed from the profile key
 * against the CURRENT legacy-owner mapping at restore time, so a mapping
 * change can never leave a tab in a jar its project no longer owns.
 *
 * WRITES ARE SERIALIZED AND ATOMIC: one pending write at a time, coalesced so
 * the file always reflects the LATEST state (a tab closed while a write was in
 * flight is gone from the next write, never resurrected), written to a temp
 * file and renamed into place.
 */
const fs = require("node:fs");
const path = require("node:path");
const { partitionFor } = require("./browser-profiles");
const { isProtectedUrl } = require("./private-interaction");

const INVENTORY_VERSION = 1;
const FILE_NAME = "browser-tabs.json";
const MAX_TABS_PER_SCOPE = 12;
const MAX_TEXT = 2_000;

function cleanText(value, fallback = "") {
  const text = typeof value === "string" ? value : "";
  return (text || fallback).slice(0, MAX_TEXT);
}

/** An http(s) URL or about:blank; null for anything the browser would not
 *  open or must not remember (extension pages). */
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

/**
 * The manager's live tabs → the inventory document. `tabs` are the manager's
 * records (scopeKey/id/url/title/openedBy/viewport), `profiles` the scope →
 * profile map, `active` the scope → active id map. A scope with no
 * rememberable tab is omitted entirely.
 */
function serializeInventory({ tabs, profiles, active }) {
  const scopes = {};
  for (const tab of tabs) {
    const profileKey = profiles.get(tab.scopeKey);
    if (!profileKey) continue;
    const url = rememberableUrl(tab.url);
    if (url === null) continue;
    const scope = (scopes[tab.scopeKey] ||= { profileKey, activeTabId: null, tabs: [] });
    if (scope.tabs.length >= MAX_TABS_PER_SCOPE) continue;
    scope.tabs.push({
      id: tab.id,
      url,
      title: cleanText(tab.title, "New tab"),
      openedBy: tab.openedBy === "human" ? "human" : "agent",
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

/**
 * A document from disk → validated scopes the manager may restore. Anything
 * malformed is dropped at the smallest granularity that keeps the rest: a bad
 * tab costs the tab, a scope whose profile the mapping refuses costs the
 * scope, an unreadable document costs nothing but the memory of it.
 * `mapping` is the legacy-owner mapping `partitionFor` validates against.
 */
function parseInventory(document, mapping) {
  const scopes = [];
  if (!document || typeof document !== "object" || document.version !== INVENTORY_VERSION) return scopes;
  const raw = document.scopes && typeof document.scopes === "object" ? document.scopes : {};
  for (const [scopeKey, scope] of Object.entries(raw)) {
    if (!scopeKey.trim() || !scope || typeof scope !== "object") continue;
    const profileKey = cleanText(scope.profileKey);
    try {
      partitionFor(profileKey, mapping);
    } catch {
      continue; // an unmappable profile is not a reason to guess a jar
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
      tabs.push({
        id,
        url,
        title: cleanText(tab.title, "New tab"),
        openedBy: tab.openedBy === "human" ? "human" : "agent",
        ...(viewport === undefined ? {} : { viewport }),
        // Absent on legacy inventories; the manager migrates those.
        ...(tab.viewportMode === "fit" || tab.viewportMode === "fixed" ? { viewportMode: tab.viewportMode } : {}),
      });
      if (tabs.length >= MAX_TABS_PER_SCOPE) break;
    }
    if (!tabs.length) continue;
    const activeTabId = tabs.some((tab) => tab.id === scope.activeTabId) ? scope.activeTabId : tabs.at(-1).id;
    scopes.push({ scopeKey, profileKey, activeTabId, tabs });
  }
  return scopes;
}

/**
 * The on-disk store. `load()` is synchronous (read once at startup);
 * `save(document)` coalesces — while a write is in flight the newest document
 * waits its turn and replaces any that queued behind the same write, so the
 * file converges on the latest state with at most one write outstanding.
 * `flush()` awaits everything queued (used at quit).
 */
function createTabStore(userDataDir, { fsImpl = fs, writeDelayMs = 150, setTimer = setTimeout } = {}) {
  const file = path.join(userDataDir, FILE_NAME);
  let pending = null; // the newest document waiting to be written
  let timer = null;
  let inFlight = Promise.resolve();
  let idle = Promise.resolve();
  let resolveIdle = null;
  /**
   * THE REVISION GUARD. Every document handed to `save`/`flushSync` takes
   * the next revision; an async write checks, immediately before its rename,
   * that no NEWER revision has already landed on disk. Without this a
   * synchronous quit-time write could be overwritten a moment later by an
   * older async write that was mid-`writeFile` when the flush ran — and the
   * next launch would restore a tab the person had closed.
   */
  let revision = 0;
  let landed = 0; // the highest revision known to be the file's content
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
        // A newer revision (a flushSync, or a later async write) reached the
        // file while this one was being written: this one is stale and must
        // not replace it. The check and the rename are ONE synchronous step
        // — an async rename could be dispatched before a flushSync and
        // complete after it, landing stale content last.
        if (landed > rev) return;
        fsImpl.renameSync(tmp, file);
        landed = Math.max(landed, rev);
      } finally {
        try { fsImpl.unlinkSync(tmp); } catch { /* renamed away, or never written */ }
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
    /** Write whatever is pending now and wait for the disk to have it. */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending) writeNow();
      return resolveIdle ? idle : inFlight;
    },
    /**
     * The quit / dispose path: the newest document goes to disk NOW,
     * synchronously, and takes a revision above every write still in flight
     * — so an older async write completing after this one finds itself stale
     * at its rename check and leaves this content in place.
     */
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
      // Nothing is pending after a sync flush; a waiter on `flush()` is done.
      settleIdle();
    },
    /** The last write failure, for a harness that must not pass on a silent
     *  console line. */
    get lastError() { return lastError; },
  };
}

module.exports = { createTabStore, serializeInventory, parseInventory, rememberableUrl, INVENTORY_VERSION, FILE_NAME };
