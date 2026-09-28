const { HUMAN_ACTIVE_MS, HUMAN_ATTRIBUTION_GRACE_MS, SYNTHETIC_REPORT_TTL_MS, humanActiveOn, staleView } = require("./shared");
const { captureEntry } = require("../login/login-offer");
const { isProtectedUrl } = require("./protected-urls");

module.exports = {
  humanActive(tab) {
    return tab.lastHumanInputAt !== undefined && this.now() - tab.lastHumanInputAt < HUMAN_ACTIVE_MS;
  },

  controllerOf(scopeKey) {
    const scope = this.requireScope(scopeKey);
    const tab = this.tabs.find((candidate) => candidate.scopeKey === scope && candidate.id === this.activeTabIds.get(scope));
    if (!tab) return "idle";
    return this.tabActivity(tab);
  },

  tabActivity(tab) {
    if (this.humanActive(tab)) return "human";
    if (tab.agentBusy > 0) return "agent";
    return "idle";
  },

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
  },

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
  },

  noteHumanInputFromWebContents(webContents) {
    const tab = this.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
    if (tab) this.noteHumanInput(tab.scopeKey, { tab });
  },

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
  },

  finishLoginEntry() {
    const capture = this.heldLoginCapture;
    this.heldLoginCapture = null;
    if (!capture || !this.onLoginEntryFinished) return;
    try {
      this.onLoginEntryFinished(capture);
    } catch {
    }
  },

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
  },

  noteNavigation(tab) {
    tab.generation += 1;
    tab.staleReason = "the page navigated";
    if (tab.loginEntryAt !== undefined) {
      tab.loginEntryAt = undefined;
      this.finishLoginEntry();
    }
  },

  noteVisited(tab, url, httpResponseCode) {
    if (!this.onVisited) return;
    if (typeof httpResponseCode === "number" && (httpResponseCode === 0 || httpResponseCode >= 400)) return;
    let parsed;
    try { parsed = new URL(String(url || "")); } catch { return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (isProtectedUrl(parsed.href)) return;
    try { this.onVisited(tab.scopeKey, parsed.href); } catch {  }
  },

  stampAgentInput(tab, reports = 0) {
    const now = this.now();

    if (tab.expectedReports.length) {
      tab.expectedReports = tab.expectedReports.filter((at) => now - at < SYNTHETIC_REPORT_TTL_MS);
    }
    for (let i = 0; i < reports; i += 1) tab.expectedReports.push(now);
    this.lastAgentInputAt.set(tab.scopeKey, now);
  },

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
  },

  noteObserved(tab) {
    tab.observedGeneration = tab.generation;
  },

  nextTicket(tab) {
    tab.ticket = (tab.ticket || 0) + 1;
    return tab.ticket;
  },
};
