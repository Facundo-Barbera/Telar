const { randomUUID } = require("node:crypto");

const CURSOR_MOVE_MS = 160;
const CURSOR_CLICK_LEAD_MS = 40;
const RPC_TIMEOUT_MS = 30_000;
const HIBERNATE_GRACE_MS = RPC_TIMEOUT_MS;
const MAX_LOG_ITEMS = 200;
const MAX_LIVE_VIEWS = 6;

// --- The shared-browser control model (§6, docs/browser-v2-plan.md) ---------
// Agent-synthesized CDP input raises the SAME DOM events a human's hands do,
// so attribution is temporal: input seen while an agent call is in flight, or
// within this many ms of agent-dispatched input, belongs to the agent. The
// race window means a human click inside it can be missed ONCE — the next
// input flips control. Chosen over a marker protocol because the marker would
// have to survive every page's own event handling.
const HUMAN_ATTRIBUTION_GRACE_MS = 400;

const HUMAN_HOLDS_BROWSER =
  "The human took the browser — wait for it back. You can still look (snapshot, screenshot, console, network) to see what they are doing.";

// The reads an agent keeps during human control: watching is the point of a
// SHARED browser. Everything else — anything that changes the page or the tab
// set — waits for the handback.
const READ_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
]);

function isReadTool(name, args) {
  return READ_TOOLS.has(name) || (name === "browser_tabs" && args?.action === "list");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createElectronView(options) {
  const { WebContentsView } = require("electron");
  return new WebContentsView(options);
}

function okText(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The integrated browser only opens http and https URLs.");
  }
  return parsed.href;
}

// --- External-link policy (issue #35) ---------------------------------------
// The tabs this file owns are a feature: agents drive those WebContentsView
// instances and they must keep rendering in-app. Every OTHER link is the
// opposite case — an in-app window has no password manager, no session the user
// is already signed into, and no address bar to check an origin against, which
// is what makes MCP OAuth a repeated chore and a login page unverifiable. So
// the shell needs a rule that separates the two, and it belongs beside
// normalizeUrl: this file already owns every URL-scheme rule the desktop
// applies, and both rules answer one question — what may render inside Telar.
//
// Pure on purpose. main.js wires it to the app window's webContents only;
// nothing here ever reaches the tabs above.

// A denied window.open returns null to the renderer, and the popup pattern
// Telar's own MCP OAuth connect uses falls back to assigning location.href —
// the same URL arriving a second time, through will-navigate. Without
// suppression one click opens two browser tabs.
const EXTERNAL_OPEN_DEDUPE_MS = 2_000;

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * `localhost:3000` AND `127.0.0.1:3000` ARE THE SAME SERVER, and a string
 * comparison of origins says they are not.
 *
 * The shell loads the cockpit as `http://127.0.0.1:<port>/`, so a link, a
 * redirect or an automated navigation that spells the same server `localhost`
 * was read as the open web: the navigation was cancelled and the page handed to
 * the system browser. Every attempt opened another browser window while the app
 * itself sat on "This page couldn't load", which is precisely the pair of
 * symptoms that made this worth finding.
 *
 * THE PORT AND SCHEME STILL HAVE TO MATCH. A different port on loopback is a
 * different server — a Vite dev server, someone else's app — and that case must
 * keep leaving for the browser. This widens the app's own identity by exactly
 * the set of names that resolve to this machine, and by nothing else.
 */
function sameLoopbackServer(target, appUrl) {
  if (target.protocol !== appUrl.protocol) return false;
  if (target.port !== appUrl.port) return false;
  return LOOPBACK_HOSTS.has(target.hostname) && LOOPBACK_HOSTS.has(appUrl.hostname);
}

function createExternalLinkPolicy({ appUrl, now = Date.now, dedupeMs = EXTERNAL_OPEN_DEDUPE_MS } = {}) {
  const parsedAppUrl = parseUrl(appUrl);
  // AD-11: without a usable origin this policy cannot tell Telar's own UI from
  // the web, and the failure mode is not "fail closed" — it is the app handing
  // its own pages to the system browser and refusing to render itself. The
  // caller always has a real URL by construction; a mistyped TELAR_DESKTOP_URL
  // is the one way to get here, and it has to stop the launch, not survive it.
  if (!parsedAppUrl || (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:")) {
    throw new Error(
      `External-link policy needs an http(s) app URL to recognise Telar's own UI; got ${JSON.stringify(appUrl ?? null)}.`,
    );
  }
  const appOrigin = parsedAppUrl.origin;
  let lastHref = null;
  let lastAt = 0;
  return {
    decide(target) {
      const parsed = parseUrl(target);
      // about:blank is the app opening a surface it navigates itself; that
      // navigation returns through this same policy, so allowing the blank
      // window costs nothing and leaves ordinary popup code working.
      if (
        parsed &&
        (parsed.href === "about:blank" || parsed.origin === appOrigin || sameLoopbackServer(parsed, parsedAppUrl))
      ) {
        return { action: "allow", openExternal: null };
      }
      // shell.openExternal hands whatever it is given to the OS — file://,
      // smb:// and every registered handler included — and model output can
      // contain links, so only the two web schemes are ever passed on.
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return { action: "deny", openExternal: null };
      }
      const at = now();
      if (parsed.href === lastHref && at - lastAt < dedupeMs) {
        // Reported rather than dropped: a suppressed hand-off is
        // indistinguishable from a broken link to the user, so the caller has
        // somewhere to say so.
        return { action: "deny", openExternal: null, duplicateOf: parsed.href };
      }
      lastHref = parsed.href;
      lastAt = at;
      // The parsed href, not the raw string: the OS receives exactly what was
      // validated here.
      return { action: "deny", openExternal: parsed.href };
    },
  };
}

function axValue(node, key) {
  const value = node?.[key]?.value;
  return value === undefined || value === null ? "" : String(value);
}

function navigationFlag(webContents, method) {
  const history = webContents.navigationHistory;
  return Boolean(history && typeof history[method] === "function" && history[method]());
}

class DesktopBrowserManager {
  constructor(window, dependencies = {}) {
    this.window = window;
    this.createView = dependencies.createView || createElectronView;
    this.createId = dependencies.createId || randomUUID;
    this.wait = dependencies.wait || sleep;
    this.tabs = [];
    this.activeTabIds = new Map();
    this.visibleScopeKey = null;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.version = 0;
    this.maxLiveViews = dependencies.maxLiveViews || MAX_LIVE_VIEWS;
    this.activeToolCalls = new Map();
    // scope → "agent" | "human"; absent means idle. See the § above the
    // constants: three states, explicit handback, epoch preemption.
    this.controllers = new Map();
    // Bumped on every human takeover. An agent action that started under an
    // older epoch returns an error instead of its result — t3code's trick,
    // with the interruption REPORTED to the model rather than swallowed.
    this.controlEpochs = new Map();
    this.lastAgentInputAt = new Map();
    this.now = dependencies.now || Date.now;
    // The shell forwards these to the engine journal (browser.control.changed)
    // and the renderer hears them through the ordinary state push.
    this.onControlChanged = dependencies.onControlChanged || null;
  }

  controllerOf(scopeKey) {
    return this.controllers.get(this.requireScope(scopeKey)) || "idle";
  }

  setController(scopeKey, controller) {
    const scope = this.requireScope(scopeKey);
    const current = this.controllers.get(scope) || "idle";
    if (current === controller) return;
    if (controller === "idle") this.controllers.delete(scope);
    else this.controllers.set(scope, controller);
    if (controller === "human") {
      this.controlEpochs.set(scope, (this.controlEpochs.get(scope) || 0) + 1);
    }
    if (this.onControlChanged) {
      try {
        this.onControlChanged({ scopeKey: scope, controller, at: new Date(this.now()).toISOString() });
      } catch {
        // The journal hook must never break the browser under it.
      }
    }
    this.emitState(scope);
  }

  /**
   * A human's hands landed in this scope's page. `force` is for input that is
   * human BY CONSTRUCTION — the cockpit's URL bar and tab strip — and skips
   * the temporal attribution that in-page events need (see the constant).
   * Returns whether the input was attributed to the human.
   */
  noteHumanInput(scopeKey, options = {}) {
    const scope = this.requireScope(scopeKey);
    if (!options.force) {
      const busy = (this.activeToolCalls.get(scope) || 0) > 0;
      const recent = this.now() - (this.lastAgentInputAt.get(scope) || 0) < HUMAN_ATTRIBUTION_GRACE_MS;
      if (busy || recent) return false;
    }
    this.setController(scope, "human");
    return true;
  }

  /** The ipc path: a tab preload reported input and all we hold is the sender. */
  noteHumanInputFromWebContents(webContents) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (tab) this.noteHumanInput(tab.scopeKey);
  }

  /** The explicit affordance — the ONLY way the agent gets the browser back.
   *  A human handing back is a decision, never a timeout. */
  handBack(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.setController(scope, "agent");
    return this.state(scope);
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

  state(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    const activeTabId = this.activeTabIds.get(scope) ?? null;
    return {
      scopeKey: scope,
      available: true,
      running: true,
      provider: "desktop",
      controller: this.controllers.get(scope) || "idle",
      tabs: tabs.map((tab, index) => ({
        index,
        id: tab.id,
        title: tab.title || `Tab ${index + 1}`,
        url: tab.url || "about:blank",
        active: tab.id === activeTabId,
        loading: tab.loading,
        canGoBack: tab.view ? navigationFlag(tab.view.webContents, "canGoBack") : false,
        canGoForward: tab.view ? navigationFlag(tab.view.webContents, "canGoForward") : false,
      })),
      screenshot: null,
      error: null,
      version: this.version,
    };
  }

  emitState(scopeKey) {
    const scope = this.requireScope(scopeKey);
    this.version += 1;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:state", this.state(scope));
    }
  }

  applyVisibility() {
    for (const tab of this.tabs) {
      if (!tab.view) continue;
      const active = tab.scopeKey === this.visibleScopeKey &&
        tab.id === this.activeTabIds.get(tab.scopeKey);
      tab.view.setVisible(active);
      if (active) tab.view.setBounds(this.bounds);
    }
  }

  setBounds(scopeKey, input) {
    this.requireScope(scopeKey);
    const next = {
      x: Math.max(0, Math.round(Number(input?.x) || 0)),
      y: Math.max(0, Math.round(Number(input?.y) || 0)),
      width: Math.max(1, Math.round(Number(input?.width) || 1)),
      height: Math.max(1, Math.round(Number(input?.height) || 1)),
    };
    this.bounds = next;
    this.applyVisibility();
  }

  async setVisible(scopeKey, visible) {
    const scope = this.requireScope(scopeKey);
    if (visible) {
      this.visibleScopeKey = scope;
      for (const tab of this.scopeTabs(scope)) {
        if (!tab.destroyWhenIdle) this.cancelDeferredHibernate(tab);
      }
      const active = this.scopeTabs(scope).length ? this.activeTab(scope) : null;
      if (active) {
        try {
          await this.wakeTab(active);
        } catch {
          // The native view still renders Electron's navigation failure page.
          // Visibility restoration must not become an unhandled renderer
          // rejection merely because the remembered local server is offline.
        }
      }
    }
    else if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
  }

  hideVisibleScope() {
    const scope = this.visibleScopeKey;
    if (!scope) return;
    this.visibleScopeKey = null;
    this.applyVisibility();
    // A renderer reload has no viewport to return to and is the one lifecycle
    // where eagerly reclaiming the native view is useful. Ordinary panel/chat
    // switches call setVisible(false), which now only hides so background
    // agents keep a live page and returning users get an immediate render.
    this.releaseScope(scope);
  }

  createViewForTab(tab) {
    const view = this.createView({
      webPreferences: {
        partition: "persist:telar-integrated-browser",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The human-input reporter (see browser-tab-preload.js) — how a click
        // in the page becomes a control-model takeover in the main process.
        preload: require("node:path").join(__dirname, "browser-tab-preload.js"),
      },
    });
    // Let the themed renderer host show through while a page is navigating.
    // An opaque white native underlay otherwise appears as a strip whenever
    // its bounds update a frame ahead of the surrounding right-panel layout.
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    tab.view = view;
    tab.hibernating = false;
    tab.refs.clear();
    tab.console = [];
    tab.network = [];
    tab.debuggerReady = false;
    tab.debuggerListenersBound = false;
    this.bindTab(tab);
    return view;
  }

  async wakeTab(tab) {
    tab.lastUsedAt = Date.now();
    if (tab.view) return tab;
    const view = this.createViewForTab(tab);
    const destination = normalizeUrl(tab.url);
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    return tab;
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
      await tab.view.webContents.loadURL(url);
    } finally {
      this.endNavigation(tab);
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

  hibernateTab(tab) {
    if (!tab.view) return;
    this.cancelDeferredHibernate(tab);
    const view = tab.view;
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
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
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

  async createTab(scopeKey, url = "about:blank") {
    const scope = this.requireScope(scopeKey);
    const tab = {
      id: this.createId(),
      scopeKey: scope,
      view: null,
      title: "New tab",
      url: "about:blank",
      loading: false,
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
    this.tabs.push(tab);
    this.activeTabIds.set(scope, tab.id);
    const view = this.createViewForTab(tab);
    this.applyVisibility();
    const destination = normalizeUrl(url);
    if (destination !== "about:blank") await this.loadTab(tab, destination);
    this.enforceLiveViewBudget(tab);
    this.emitState(scope);
    return tab;
  }

  bindTab(tab) {
    const view = tab.view;
    const wc = view.webContents;
    const sync = () => {
      tab.url = wc.getURL() || "about:blank";
      tab.title = wc.getTitle() || (tab.url === "about:blank" ? "New tab" : tab.url);
      this.emitState(tab.scopeKey);
    };
    wc.on("did-start-loading", () => {
      tab.loading = true;
      tab.refs.clear();
      sync();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      sync();
      this.finishDeferredHibernate(tab);
    });
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.emitState(tab.scopeKey);
    });
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("destroyed", () => {
      if (tab.hibernating || tab.view !== view) return;
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);
      const scoped = this.scopeTabs(tab.scopeKey);
      if (this.activeTabIds.get(tab.scopeKey) === tab.id) {
        this.activeTabIds.set(tab.scopeKey, scoped.at(-1)?.id ?? null);
      }
      this.applyVisibility();
      this.emitState(tab.scopeKey);
    });
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

  async selectTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabAt(scope, index);
    await this.wakeTab(tab);
    this.activeTabIds.set(scope, tab.id);
    this.applyVisibility();
    this.emitState(scope);
  }

  closeTab(scopeKey, index) {
    const scope = this.requireScope(scopeKey);
    const scoped = this.scopeTabs(scope);
    const tab = index === undefined ? this.activeTab(scope) : this.tabAt(scope, index);
    const position = scoped.indexOf(tab);
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.hibernateTab(tab);
    if (this.activeTabIds.get(scope) === tab.id) {
      const remaining = this.scopeTabs(scope);
      this.activeTabIds.set(scope, remaining[position]?.id ?? remaining[position - 1]?.id ?? null);
    }
    this.applyVisibility();
    this.emitState(scope);
  }

  /**
   * The IPC surface behind the cockpit's own chrome — URL bar, tab strip,
   * back/forward — which is a human's hand by construction. Typing an address
   * IS taking the browser (§6): the agent hears about it on its next mutating
   * call and waits for the handback. The agent's own `browser_navigate_back`
   * goes through `performAction` below and never touches control.
   */
  async action(scopeKey, action) {
    const scope = this.requireScope(scopeKey);
    this.noteHumanInput(scope, { force: true });
    return this.performAction(scope, action);
  }

  async performAction(scopeKey, action) {
    const scope = this.requireScope(scopeKey);
    switch (action?.action) {
      case "new":
        await this.createTab(scope, action.url || "about:blank");
        break;
      case "select":
        await this.selectTab(scope, action.index);
        break;
      case "close":
        this.closeTab(scope, action.index);
        break;
      case "navigate": {
        const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : await this.createTab(scope);
        await this.navigateTab(tab, action.url);
        break;
      }
      case "back": {
        const tab = await this.wakeTab(this.activeTab(scope));
        const wc = tab.view.webContents;
        if (navigationFlag(wc, "canGoBack")) wc.navigationHistory.goBack();
        break;
      }
      case "forward": {
        const tab = await this.wakeTab(this.activeTab(scope));
        const wc = tab.view.webContents;
        if (navigationFlag(wc, "canGoForward")) wc.navigationHistory.goForward();
        break;
      }
      case "reload":
        (await this.wakeTab(this.activeTab(scope))).view.webContents.reload();
        break;
      default:
        throw new Error("Unknown desktop browser action.");
    }
    return this.state(scope);
  }

  async ensureDebugger(tab) {
    const debug = tab.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    if (!tab.debuggerListenersBound) {
      debug.on("message", (_event, method, params) => {
        if (method === "Runtime.consoleAPICalled") {
          const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
          tab.console.push({ level: params.type || "log", text });
          tab.console = tab.console.slice(-MAX_LOG_ITEMS);
        }
        if (method === "Log.entryAdded") {
          tab.console.push({ level: params.entry?.level || "info", text: params.entry?.text || "" });
          tab.console = tab.console.slice(-MAX_LOG_ITEMS);
        }
        if (method === "Network.requestWillBeSent") {
          tab.network.push({ method: params.request?.method || "GET", url: params.request?.url || "" });
          tab.network = tab.network.slice(-MAX_LOG_ITEMS);
        }
      });
      debug.on("detach", () => {
        tab.debuggerReady = false;
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
    return debug;
  }

  async snapshot(tab) {
    const debug = await this.ensureDebugger(tab);
    const result = await debug.sendCommand("Accessibility.getFullAXTree", { depth: 40 });
    tab.refs.clear();
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const depths = new Map();
    const depthOf = (node) => {
      if (!node?.parentId) return 0;
      if (depths.has(node.nodeId)) return depths.get(node.nodeId);
      const depth = Math.min(12, depthOf(byId.get(node.parentId)) + 1);
      depths.set(node.nodeId, depth);
      return depth;
    };
    const interactive = new Set([
      "button", "checkbox", "combobox", "link", "menuitem", "radio", "searchbox",
      "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
    ]);
    const lines = [`Page: ${tab.title}`, `URL: ${tab.url}`, ""];
    let nextRef = 1;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = axValue(node, "role");
      const name = axValue(node, "name").replace(/\s+/g, " ").trim();
      const value = axValue(node, "value").replace(/\s+/g, " ").trim();
      const backendNodeId = Number(node.backendDOMNodeId || 0);
      const canTarget = backendNodeId > 0 && (interactive.has(role) || role === "img");
      if (!name && !value && !canTarget) continue;
      let ref = "";
      if (canTarget) {
        ref = `e${nextRef++}`;
        tab.refs.set(ref, backendNodeId);
      }
      const label = [role || "node", name ? `\"${name}\"` : "", value ? `value=\"${value}\"` : "", ref ? `[ref=${ref}]` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`${"  ".repeat(depthOf(node))}- ${label}`);
      if (lines.length >= 500) {
        lines.push("- … snapshot truncated");
        break;
      }
    }
    return okText(lines.join("\n"));
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

  async click(tab, args) {
    const point = await this.targetPoint(tab, args.target);
    await this.showAgentCursor(tab, point, "move");
    await this.wait(CURSOR_MOVE_MS);
    await this.showAgentCursor(tab, point, "click");
    await this.wait(CURSOR_CLICK_LEAD_MS);
    const debug = await this.ensureDebugger(tab);
    const button = args.button || "left";
    const clickCount = args.doubleClick ? 2 : 1;
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount });
    return okText(`Clicked ${args.element || args.target}.`);
  }

  async type(tab, args) {
    const backendNodeId = this.backendNode(tab, args.target);
    await this.callOnNode(
      tab,
      backendNodeId,
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); if ('value' in this) { this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); } }",
    );
    const debug = await this.ensureDebugger(tab);
    const text = String(args.text ?? "");
    if (args.slowly) {
      for (const char of text) {
        await debug.sendCommand("Input.insertText", { text: char });
        await this.wait(15);
      }
    } else {
      await debug.sendCommand("Input.insertText", { text });
    }
    if (args.submit) await this.press(tab, { key: "Enter" });
    return okText(`Typed into ${args.element || args.target}.`);
  }

  async press(tab, args) {
    const key = String(args.key || "");
    if (!key) throw new Error("A key is required.");
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    return okText(`Pressed ${key}.`);
  }

  async fillForm(tab, args) {
    for (const field of Array.isArray(args.fields) ? args.fields : []) {
      const backendNodeId = this.backendNode(tab, field.target);
      if (field.type === "checkbox" || field.type === "radio") {
        const checked = /^(true|1|yes|on)$/i.test(String(field.value));
        await this.callOnNode(tab, backendNodeId, "function(value){ if (this.checked !== value) this.click(); }", [checked]);
      } else if (field.type === "combobox") {
        await this.selectOption(tab, { target: field.target, values: [field.value] });
      } else {
        await this.type(tab, { target: field.target, element: field.element || field.name, text: field.value });
      }
    }
    return okText("Filled the requested form fields.");
  }

  async selectOption(tab, args) {
    const backendNodeId = this.backendNode(tab, args.target);
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
    const result = await debug.sendCommand("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: Boolean(args.fullPage),
    });
    return { content: [{ type: "image", data: result.data, mimeType: `image/${format}` }] };
  }

  listTabs(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tabs = this.scopeTabs(scope);
    if (!tabs.length) return okText("No browser tabs are open in this session.");
    const activeTabId = this.activeTabIds.get(scope);
    return okText(tabs.map((tab, index) => `- ${index}: ${tab.id === activeTabId ? "(current) " : ""}[${tab.title}](${tab.url})`).join("\n"));
  }

  async callTool(scopeKey, name, args = {}) {
    const scope = this.requireScope(scopeKey);
    const read = isReadTool(name, args);
    // While the human holds the browser the agent may LOOK — that is what
    // makes this a shared browser rather than a lock — but not touch. The
    // refusal is a sentence the model can narrate, not a throw it retries.
    if (!read && this.controllerOf(scope) === "human") {
      return errorResult(new Error(HUMAN_HOLDS_BROWSER));
    }
    // A mutating call is the agent's hand on the wheel: claim control (from
    // idle — never from human, refused above) and remember the epoch so a
    // takeover DURING the action turns its result into the same sentence.
    const epochAtStart = this.controlEpochs.get(scope) || 0;
    if (!read) {
      this.setController(scope, "agent");
      this.lastAgentInputAt.set(scope, this.now());
    }
    this.activeToolCalls.set(scope, (this.activeToolCalls.get(scope) || 0) + 1);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Browser action ${name} timed out.`)), RPC_TIMEOUT_MS);
    });
    const operation = (async () => {
      switch (name) {
        case "browser_tabs":
          if (args.action === "list") return this.listTabs(scope);
          if (args.action === "new") { await this.createTab(scope, args.url || "about:blank"); return this.listTabs(scope); }
          if (args.action === "select") { await this.selectTab(scope, args.index); return this.listTabs(scope); }
          if (args.action === "close") { this.closeTab(scope, args.index); return this.listTabs(scope); }
          throw new Error("Unknown browser_tabs action.");
        case "browser_navigate": {
          const tab = this.scopeTabs(scope).length ? this.activeTab(scope) : await this.createTab(scope);
          await this.navigateTab(tab, args.url);
          return okText(`Navigated to ${tab.view.webContents.getURL()}.`);
        }
        case "browser_navigate_back": await this.performAction(scope, { action: "back" }); return okText("Navigated back.");
        case "browser_snapshot": return this.snapshot(await this.wakeTab(this.activeTab(scope)));
        case "browser_click": return this.click(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_type": return this.type(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_fill_form": return this.fillForm(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_select_option": return this.selectOption(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_press_key": return this.press(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_hover": {
          const tab = await this.wakeTab(this.activeTab(scope));
          const point = await this.targetPoint(tab, args.target);
          await this.showAgentCursor(tab, point, "move");
          const debug = await this.ensureDebugger(tab);
          await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
          return okText(`Hovered ${args.element || args.target}.`);
        }
        case "browser_take_screenshot": return this.screenshot(await this.wakeTab(this.activeTab(scope)), args);
        case "browser_console_messages": {
          const tab = await this.wakeTab(this.activeTab(scope));
          await this.ensureDebugger(tab);
          return okText(tab.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n") || "No console messages captured.");
        }
        case "browser_network_requests": {
          const tab = await this.wakeTab(this.activeTab(scope));
          await this.ensureDebugger(tab);
          const filter = String(args.filter || "");
          const rows = tab.network.filter((entry) => !filter || entry.url.includes(filter));
          return okText(rows.map((entry) => `${entry.method} ${entry.url}`).join("\n") || "No network requests captured.");
        }
        default: throw new Error(`Unsupported desktop browser tool: ${name}.`);
      }
    })();
    try {
      const result = await Promise.race([operation, timeout]);
      // The human preempted mid-action (epoch bumped): the action may or may
      // not have landed, and saying so honestly beats returning a result that
      // implies the agent still drives. t3code interrupts silently; Telar
      // tells the model, so it narrates and waits instead of fighting.
      if (!read && (this.controlEpochs.get(scope) || 0) !== epochAtStart) {
        return errorResult(new Error(HUMAN_HOLDS_BROWSER));
      }
      return result;
    } catch (error) {
      return errorResult(error);
    } finally {
      clearTimeout(timeoutId);
      if (!read) this.lastAgentInputAt.set(scope, this.now());
      const remaining = Math.max(0, (this.activeToolCalls.get(scope) || 1) - 1);
      if (remaining) this.activeToolCalls.set(scope, remaining);
      else this.activeToolCalls.delete(scope);
      for (const tab of this.scopeTabs(scope)) this.finishDeferredHibernate(tab);
    }
  }

  releaseScope(scopeKey, destroy = false) {
    const scope = this.requireScope(scopeKey);
    for (const tab of this.scopeTabs(scope)) this.requestHibernate(tab, destroy);
    if (this.visibleScopeKey === scope) this.visibleScopeKey = null;
    this.applyVisibility();
    if (destroy && !this.scopeTabs(scope).length) this.activeTabIds.delete(scope);
    // A destroyed scope's controller is nobody. A merely-hibernated one keeps
    // its state: the human who took the browser still holds it when it wakes.
    if (destroy) this.setController(scope, "idle");
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
    const sourceActiveId = this.activeTabIds.get(from) ?? null;
    for (const tab of sourceTabs) tab.scopeKey = to;
    if (sourceTabs.length) this.activeTabIds.set(to, sourceActiveId);
    this.activeTabIds.delete(from);
    if (this.visibleScopeKey === from) this.visibleScopeKey = to;
    this.applyVisibility();
    this.emitState(from);
    this.emitState(to);
    return this.state(to);
  }

  destroy() {
    for (const tab of [...this.tabs]) {
      this.hibernateTab(tab);
    }
    this.tabs = [];
    this.activeTabIds.clear();
    this.visibleScopeKey = null;
  }
}

module.exports = { DesktopBrowserManager, createExternalLinkPolicy, normalizeUrl };
