const { logText, pushCapped, renderSnapshot } = require("./render");
const { CAPTURE_TIMEOUT_MESSAGE, CAPTURE_TIMEOUT_MS, CURSOR_CLICK_LEAD_MS, CURSOR_MOVE_MS, okText, withTimeout } = require("./shared");
const { PAGE_AT_POINT, PAGE_COPY, PAGE_FOCUSED_EDITABLE, PAGE_PASTE, capCopied, keyChord, pageLabel, pointText } = require("./page-input");
const { isProtectedUrl } = require("./protected-urls");

module.exports = {
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
  },

  async beforeNavigation(tab) {
    if (!tab.view || !tab.debuggerReady || !tab.viewportOverride) return;
    tab.viewportOverride = undefined;
    try {
      await tab.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    } catch {
    }
  },

  captureIntrinsic(debug, tab, format, fullPage, documentHeight) {
    const viewport = this.effectiveViewport(tab);

    const ratio = this.viewportTarget(tab).deviceScaleFactor || 1;
    return debug.sendCommand("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: viewport.width, height: fullPage && documentHeight ? documentHeight : viewport.height, scale: 1 / ratio },
    });
  },

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
  },

  backendNode(tab, target) {
    const ref = String(target || "").trim();
    const backendNodeId = tab.refs.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown browser target ${ref || "(empty)"}. Take a fresh browser_snapshot first.`);
    }
    return backendNodeId;
  },

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
  },

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
  },

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
  },

  coordinatesOf(tab, args) {
    const hasTarget = String(args.target ?? "").trim() !== "";
    const hasX = args.x !== undefined && args.x !== null;
    const hasY = args.y !== undefined && args.y !== null;
    if (hasTarget && (hasX || hasY)) throw new Error("Pass either a target from browser_snapshot or x and y from browser_take_screenshot, not both.");
    if (hasTarget) return null;
    if (!hasX && !hasY) throw new Error("Pass a target from browser_snapshot, or x and y in the CSS pixels of browser_take_screenshot's image.");
    return this.viewportPoint(tab, args.x, args.y);
  },

  viewportPoint(tab, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y go together: pass both, as numbers in the CSS pixels of browser_take_screenshot's image.");
    const point = { x, y };
    const viewport = this.effectiveViewport(tab);
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new Error(`${pointText(point)} is outside the ${viewport.width}×${viewport.height} viewport of the screenshot. Scroll or resize, then take a fresh screenshot.`);
    }
    return point;
  },

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
  },

  async labelAt(tab, point) {
    try {
      const described = await this.evaluateInPage(tab, PAGE_AT_POINT, [point.x, point.y]);
      return described?.role ? `: ${pageLabel(described)}` : "";
    } catch {
      return "";
    }
  },

  async focusedEditable(tab) {
    return (await this.evaluateInPage(tab, PAGE_FOCUSED_EDITABLE)) || null;
  },

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
  },

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
  },

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
  },

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
  },

  async typeAtFocus(tab, args, action) {
    const focused = await this.focusedEditable(tab);
    if (!focused) {
      throw new Error("Nothing editable has focus in this tab. Click into a field or a cell first (a spreadsheet's name box or formula bar), or pass a target.");
    }
    await this.insertText(tab, String(args.text ?? ""), args.slowly, action);
    if (args.submit) await this.press(tab, { key: "Enter" }, action);
    return okText(`Typed into the focused ${pageLabel(focused)}.`);
  },

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
  },

  async press(tab, args, action) {
    const key = String(args.key || "");
    if (!key) throw new Error("A key is required.");
    const { keyCode, modifiers } = keyChord(key);
    if (action) this.checkpoint(action);

    this.stampAgentInput(tab, 1);
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    return okText(`Pressed ${key}.`);
  },

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
  },

  async copy(tab, action) {
    if (action) this.checkpoint(action);
    this.stampAgentInput(tab);
    const text = await this.evaluateInPage(tab, PAGE_COPY);
    if (typeof text !== "string" || !text) throw new Error("Nothing is selected in this tab. Select text or cells first.");
    return okText(capCopied(text));
  },

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
  },

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
  },

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
  },

  async measureDocument(debug) {
    const { result } = await debug.sendCommand("Runtime.evaluate", {
      expression: "({ width: Math.ceil(Math.max(document.documentElement.scrollWidth, innerWidth)), height: Math.ceil(Math.max(document.documentElement.scrollHeight, innerHeight)) })",
      returnByValue: true,
    });
    const metrics = result?.value;
    if (!metrics || !(metrics.width > 0 && metrics.height > 0)) throw new Error("Could not measure the page for a full-page capture.");
    return metrics;
  },

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
  },

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
  },

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
  },

  isBlank(tab) {
    const url = tab.view && !tab.view.webContents.isDestroyed?.() ? tab.view.webContents.getURL() || tab.url : tab.url;
    return (!url || url === "about:blank") && !tab.loading && tab.navigationPending === 0;
  },

  previewing(tab) {
    return Boolean(tab?.previewWindow && !tab.previewWindow.isDestroyed?.());
  },

  previewRect(tab) {
    const [width, height] = tab.previewWindow?.getContentSize?.() || [];
    const viewport = this.viewportOf(tab);
    return { x: 0, y: 0, width: Math.max(1, Math.round(width || viewport.width)), height: Math.max(1, Math.round(height || viewport.height)) };
  },

  isTabShown(tab) {
    if (this.previewing(tab)) return false;
    return tab.scopeKey === this.visibleScopeKey && tab.id === this.activeTabIds.get(tab.scopeKey);
  },

  isTabVisible(tab) {
    return this.isTabShown(tab) && this.bounds.width > 1 && this.bounds.height > 1;
  },

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
  },
};
