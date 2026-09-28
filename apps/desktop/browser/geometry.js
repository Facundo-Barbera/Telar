const { BOUNDS_SETTLE_MS, FREEZE_TIMEOUT_MESSAGE, FREEZE_TIMEOUT_MS, withTimeout } = require("./shared");
const { DEFAULT_VIEWPORT, NO_CANVAS, PAGE_CANVAS, VIEWPORT_MIN, emulationKey, fitViewport, resolveViewport, resolveZoom } = require("./viewport");
const { presetOf } = require("../viewport-presets");

module.exports = {
  scheduleBoundsEmit(scope) {
    this.cancelBoundsEmit();
    const timer = this.setTimer(() => {
      if (this.boundsEmit?.timer !== timer) return;
      this.boundsEmit = null;
      if (!this._disposed) this.pushState(scope);
    }, BOUNDS_SETTLE_MS);
    this.boundsEmit = { scope, timer };
  },

  cancelBoundsEmit() {
    if (!this.boundsEmit) return;
    this.clearTimer(this.boundsEmit.timer);
    this.boundsEmit = null;
  },

  viewportOf(tab) {
    return tab.viewport || DEFAULT_VIEWPORT;
  },

  viewportModeOf(tab) {
    return tab.viewportMode === "fixed" ? "fixed" : "fit";
  },

  fitViewportChange(tab) {
    if (this.viewportModeOf(tab) !== "fit" || !this.isTabVisible(tab)) return null;

    const stage = this.stageBounds();
    if (stage.width < VIEWPORT_MIN || stage.height < VIEWPORT_MIN) return null;
    const next = resolveViewport({ width: stage.width, height: stage.height });
    const current = this.viewportOf(tab);
    if (next.width === current.width && next.height === current.height) return null;
    return next;
  },

  syncFitViewport(tab) {
    const next = this.fitViewportChange(tab);
    if (!next) return false;
    tab.viewport = next;
    return true;
  },

  emulationSettled(tab) {
    const target = this.viewportTarget(tab);
    if (!target.emulate) return tab.viewportOverride === "native" || tab.viewportOverride === undefined;
    return tab.viewportOverride === emulationKey(target);
  },

  viewportInfo(tab) {
    const viewport = this.viewportOf(tab);
    return { width: viewport.width, height: viewport.height, preset: presetOf(viewport), mode: this.viewportModeOf(tab) };
  },

  isNativeFit(tab) {
    return this.viewportModeOf(tab) === "fit" && this.isTabVisible(tab);
  },

  cockpitZoom() {
    const factor = this.window?.webContents?.getZoomFactor?.();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  },

  deviceScaleFactor() {
    try {
      const factor = this.displayScaleFactor();
      return Number.isFinite(factor) && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  },

  windowRect(rect) {
    const zoom = this.cockpitZoom();
    return {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
  },

  stageBounds() {
    return this.windowRect(this.bounds);
  },

  effectiveViewport(tab) {
    if (!this.isNativeFit(tab)) return this.viewportOf(tab);
    const stage = this.stageBounds();
    return { width: stage.width, height: stage.height };
  },

  nativeRect(tab) {
    if (this.isNativeFit(tab)) return { ...this.bounds };
    return fitViewport(this.viewportOf(tab), this.bounds, this.zoomOf(tab)).rect;
  },

  zoomOf(tab) {
    return typeof tab.presentationZoom === "number" ? tab.presentationZoom : "fit";
  },

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
  },

  async ensureDebuggerOnly(tab) {
    const debug = tab.view.webContents.debugger;
    if (!tab.debuggerReady) await this.ensureDebugger(tab, { sync: false });
    return debug;
  },

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
  },

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
  },

  applyBorderRadius(tab, view) {
    const radius = this.previewing(tab) ? 0 : this.radiusByScope.get(tab.scopeKey) || 0;
    if (tab.borderRadius === radius) return;
    tab.borderRadius = radius;
    view.setBorderRadius?.(radius);
  },

  applyCanvas(tab, view) {
    const canvas = tab.documentReady ? PAGE_CANVAS : NO_CANVAS;
    if (tab.canvas === canvas) return;
    tab.canvas = canvas;
    view.setBackgroundColor(canvas);
  },

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
  },

  applyShownGeometry() {
    for (const tab of this.tabs) {
      if (tab.view && this.isTabShown(tab)) this.applyGeometry(tab).catch(() => {});
    }
  },

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
  },

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
  },

  async freezeView(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const frame = await this.captureFrozenFrame(scope);
    await this.setVisible(scopeKey, false);
    return frame;
  },

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
  },

  async applyVisibilityAsync(scope) {
    this.applyVisibility();
    const activeId = this.activeTabIds.get(scope);
    const active = this.tabs.find((tab) => tab.scopeKey === scope && tab.id === activeId);

    if (active?.geometry) await active.geometry.queue;
  },

  hideVisibleScope() {
    const scope = this.visibleScopeKey;
    if (!scope) return;
    this.visibleScopeKey = null;
    this.applyVisibility();
    this.emitState(scope);
  },

  ensureViewport(tab) {
    return this.applyGeometry(tab);
  },

  forgetEmulation(tab) {
    tab.viewportOverride = undefined;
    tab.colorSchemeApplied = undefined;
  },

  devToolsEdge(tab) {
    this.forgetEmulation(tab);
    this.applyGeometry(tab).catch(() => {});
    this.emitState(tab.scopeKey);
  },

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
  },

  applyZoom(tab) {
    const wc = this.contentsOf(tab);
    if (!wc?.setZoomFactor) return;
    try { wc.setZoomFactor(tab.zoom || 1); } catch {  }
  },

  needsColorScheme(tab) {
    const wanted = tab.colorScheme || "system";
    if (tab.colorSchemeApplied === wanted) return false;
    return !(wanted === "system" && tab.colorSchemeApplied === undefined);
  },

  async applyColorScheme(tab, debug) {
    const wanted = tab.colorScheme || "system";
    await debug.sendCommand("Emulation.setEmulatedMedia", {
      features: wanted === "system" ? [] : [{ name: "prefers-color-scheme", value: wanted }],
    });
    tab.colorSchemeApplied = wanted;
  },

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
  },

  inputPoint(tab, point) {
    const { scale } = this.viewportTarget(tab);
    return scale === 1 ? point : { ...point, x: point.x * scale, y: point.y * scale };
  },

  resyncViewports() {
    this.applyVisibility();
  },
};
