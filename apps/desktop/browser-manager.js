const { randomUUID } = require("node:crypto");

const CURSOR_MOVE_MS = 160;
const CURSOR_CLICK_LEAD_MS = 40;
const RPC_TIMEOUT_MS = 30_000;
const MAX_LOG_ITEMS = 200;

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
    this.activeTabId = null;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.version = 0;
  }

  state() {
    return {
      available: true,
      running: true,
      provider: "desktop",
      tabs: this.tabs.map((tab, index) => ({
        index,
        id: tab.id,
        title: tab.title || `Tab ${index + 1}`,
        url: tab.url || "about:blank",
        active: tab.id === this.activeTabId,
        loading: tab.loading,
        canGoBack: navigationFlag(tab.view.webContents, "canGoBack"),
        canGoForward: navigationFlag(tab.view.webContents, "canGoForward"),
      })),
      screenshot: null,
      error: null,
      version: this.version,
    };
  }

  emitState() {
    this.version += 1;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("telar:browser:state", this.state());
    }
  }

  applyVisibility() {
    for (const tab of this.tabs) {
      const active = this.visible && tab.id === this.activeTabId;
      tab.view.setVisible(active);
      if (active) tab.view.setBounds(this.bounds);
    }
  }

  setBounds(input) {
    const next = {
      x: Math.max(0, Math.round(Number(input?.x) || 0)),
      y: Math.max(0, Math.round(Number(input?.y) || 0)),
      width: Math.max(1, Math.round(Number(input?.width) || 1)),
      height: Math.max(1, Math.round(Number(input?.height) || 1)),
    };
    this.bounds = next;
    this.applyVisibility();
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.applyVisibility();
  }

  async createTab(url = "about:blank") {
    const id = this.createId();
    const view = this.createView({
      webPreferences: {
        partition: "persist:telar-integrated-browser",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const tab = {
      id,
      view,
      title: "New tab",
      url: "about:blank",
      loading: false,
      refs: new Map(),
      console: [],
      network: [],
      debuggerReady: false,
      debuggerListenersBound: false,
    };
    this.tabs.push(tab);
    this.activeTabId = id;
    this.bindTab(tab);
    this.applyVisibility();
    const destination = normalizeUrl(url);
    if (destination !== "about:blank") await view.webContents.loadURL(destination);
    this.emitState();
    return tab;
  }

  bindTab(tab) {
    const wc = tab.view.webContents;
    const sync = () => {
      tab.url = wc.getURL() || "about:blank";
      tab.title = wc.getTitle() || (tab.url === "about:blank" ? "New tab" : tab.url);
      this.emitState();
    };
    wc.on("did-start-loading", () => {
      tab.loading = true;
      tab.refs.clear();
      sync();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      sync();
    });
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.emitState();
    });
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("destroyed", () => {
      this.tabs = this.tabs.filter((candidate) => candidate !== tab);
      if (this.activeTabId === tab.id) this.activeTabId = this.tabs.at(-1)?.id ?? null;
      this.applyVisibility();
      this.emitState();
    });
  }

  activeTab() {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeTabId);
    if (!tab) throw new Error("Open a browser tab before using browser controls.");
    return tab;
  }

  tabAt(index) {
    const tab = this.tabs[Number(index)];
    if (!tab) throw new Error(`Browser tab ${String(index)} does not exist.`);
    return tab;
  }

  selectTab(index) {
    const tab = this.tabAt(index);
    this.activeTabId = tab.id;
    this.applyVisibility();
    this.emitState();
  }

  closeTab(index) {
    const tab = index === undefined ? this.activeTab() : this.tabAt(index);
    const position = this.tabs.indexOf(tab);
    this.tabs.splice(position, 1);
    this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeTabId === tab.id) {
      this.activeTabId = this.tabs[position]?.id ?? this.tabs[position - 1]?.id ?? null;
    }
    this.applyVisibility();
    this.emitState();
  }

  async action(action) {
    switch (action?.action) {
      case "new":
        await this.createTab(action.url || "about:blank");
        break;
      case "select":
        this.selectTab(action.index);
        break;
      case "close":
        this.closeTab(action.index);
        break;
      case "navigate": {
        const tab = this.tabs.length ? this.activeTab() : await this.createTab();
        await tab.view.webContents.loadURL(normalizeUrl(action.url));
        break;
      }
      case "back": {
        const wc = this.activeTab().view.webContents;
        if (navigationFlag(wc, "canGoBack")) wc.navigationHistory.goBack();
        break;
      }
      case "forward": {
        const wc = this.activeTab().view.webContents;
        if (navigationFlag(wc, "canGoForward")) wc.navigationHistory.goForward();
        break;
      }
      case "reload":
        this.activeTab().view.webContents.reload();
        break;
      default:
        throw new Error("Unknown desktop browser action.");
    }
    return this.state();
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
        window.__telarAgentCursorTimer = setTimeout(() => { root.style.opacity = '0'; }, 700);
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

  listTabs() {
    if (!this.tabs.length) return okText("No browser tabs are open.");
    return okText(this.tabs.map((tab, index) => `- ${index}: ${tab.id === this.activeTabId ? "(current) " : ""}[${tab.title}](${tab.url})`).join("\n"));
  }

  async callTool(name, args = {}) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Browser action ${name} timed out.`)), RPC_TIMEOUT_MS);
    });
    const operation = (async () => {
      switch (name) {
        case "browser_tabs":
          if (args.action === "list") return this.listTabs();
          if (args.action === "new") { await this.createTab(args.url || "about:blank"); return this.listTabs(); }
          if (args.action === "select") { this.selectTab(args.index); return this.listTabs(); }
          if (args.action === "close") { this.closeTab(args.index); return this.listTabs(); }
          throw new Error("Unknown browser_tabs action.");
        case "browser_navigate": {
          const tab = this.tabs.length ? this.activeTab() : await this.createTab();
          await tab.view.webContents.loadURL(normalizeUrl(args.url));
          return okText(`Navigated to ${tab.view.webContents.getURL()}.`);
        }
        case "browser_navigate_back": await this.action({ action: "back" }); return okText("Navigated back.");
        case "browser_snapshot": return this.snapshot(this.activeTab());
        case "browser_click": return this.click(this.activeTab(), args);
        case "browser_type": return this.type(this.activeTab(), args);
        case "browser_fill_form": return this.fillForm(this.activeTab(), args);
        case "browser_select_option": return this.selectOption(this.activeTab(), args);
        case "browser_press_key": return this.press(this.activeTab(), args);
        case "browser_hover": {
          const tab = this.activeTab();
          const point = await this.targetPoint(tab, args.target);
          await this.showAgentCursor(tab, point, "move");
          const debug = await this.ensureDebugger(tab);
          await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
          return okText(`Hovered ${args.element || args.target}.`);
        }
        case "browser_take_screenshot": return this.screenshot(this.activeTab(), args);
        case "browser_console_messages": {
          const tab = this.activeTab();
          await this.ensureDebugger(tab);
          return okText(tab.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n") || "No console messages captured.");
        }
        case "browser_network_requests": {
          const tab = this.activeTab();
          await this.ensureDebugger(tab);
          const filter = String(args.filter || "");
          const rows = tab.network.filter((entry) => !filter || entry.url.includes(filter));
          return okText(rows.map((entry) => `${entry.method} ${entry.url}`).join("\n") || "No network requests captured.");
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
    }
  }

  destroy() {
    for (const tab of [...this.tabs]) {
      try { this.window.contentView.removeChildView(tab.view); } catch {}
      try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
    }
    this.tabs = [];
  }
}

module.exports = { DesktopBrowserManager, normalizeUrl };
