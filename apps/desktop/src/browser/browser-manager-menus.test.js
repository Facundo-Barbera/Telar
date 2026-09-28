const { describe, expect, test } = require("bun:test");

const { zoomStep, ZOOM_STEPS } = require("./browser-manager");
const { makeHarness } = require("../../test/browser-manager-harness");

function rightClick(harness, view, params = {}) {
  view.webContents.emit("context-menu", {}, { x: 12, y: 34, pageURL: view.webContents.getURL(), ...params });
  return harness.menus.at(-1);
}

function pick(menu, label) {
  const item = menu.template.find((entry) => entry.label === label);
  if (!item) throw new Error(`No context-menu row labelled ${JSON.stringify(label)}; saw ${menu.template.map((entry) => entry.label ?? "—").join(", ")}`);
  item.click();
  return item;
}
describe("the page's context menu and its DevTools (#423)", () => {
  test("a right-click on the page pops a native menu built from Chromium's params", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const menu = rightClick(harness, harness.views[0]);
    expect(menu.popups).toBe(1);
    expect(menu.template.map((entry) => entry.label ?? "—")).toEqual([
      "Back",
      "Forward",
      "Reload",
      "—",
      "View Page Source",
      "Inspect",
    ]);
  });

  test("Inspect opens DevTools DETACHED, on the element under the pointer", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    pick(rightClick(harness, harness.views[0], { x: 120, y: 240 }), "Inspect");

    expect(wc.devToolsOptions).toEqual({ mode: "detach" });
    expect(wc.inspected).toEqual([{ x: 120, y: 240 }]);
    expect(harness.manager.state("session-a").tabs[0].devtools).toBe(true);
  });

  test("DevTools are the TAB'S and close with it — never a window left addressing nothing", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    await harness.manager.createTab("session-a", "https://other.example");
    const [first, second] = harness.views;
    pick(rightClick(harness, first), "Inspect");
    expect(first.webContents.isDevToolsOpened()).toBe(true);

    expect(harness.manager.state("session-a").tabs.map((tab) => tab.devtools)).toEqual([true, false]);
    harness.manager.closeTab("session-a", 0);
    expect(first.webContents.isDevToolsOpened()).toBe(false);
    expect(second.webContents.isDevToolsOpened()).toBe(false);
  });

  test("⌥⌘I toggles DevTools for the tab the human is looking at, and does nothing with no tab", async () => {
    const harness = makeHarness();

    harness.manager.declareProfile("session-a", "none");
    expect((await harness.manager.action("session-a", { action: "toggle-devtools" })).tabs).toEqual([]);

    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    await harness.manager.action("session-a", { action: "toggle-devtools" });
    expect(wc.isDevToolsOpened()).toBe(true);

    expect(wc.inspected).toEqual([]);
    await harness.manager.action("session-a", { action: "toggle-devtools" });
    expect(wc.isDevToolsOpened()).toBe(false);
  });

  test("DevTools stay out of the agent's reach — performAction refuses the id", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    await expect(harness.manager.performAction("session-a", { action: "toggle-devtools" })).rejects.toThrow(
      "Unknown desktop browser action",
    );
    expect(harness.views[0].webContents.isDevToolsOpened()).toBe(false);
  });

  test("a devtools window the person closed themselves is a state push", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    pick(rightClick(harness, harness.views[0]), "Inspect");
    const before = harness.messages.length;
    wc.closeDevTools();
    expect(harness.messages.length).toBeGreaterThan(before);
    expect(harness.messages.at(-1).payload.tabs[0].devtools).toBe(false);
  });

  test("a link's new tab goes through the ordinary open-tab path, as the human's", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "https://example.com/other" }), "Open Link in New Tab");
    await harness.manager.settlePopupTabs();
    const tabs = harness.manager.state("session-a").tabs;
    expect(tabs).toHaveLength(2);

    expect(tabs[1]).toMatchObject({ url: "https://example.com/other", openedBy: "human", active: true });
  });

  test("Copy Link writes the link, not the page", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "https://example.com/other" }), "Copy Link");
    expect(harness.clipboard.text).toBe("https://example.com/other");
  });

  test("a link the popup rule refuses opens NOTHING, silently", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { linkURL: "javascript:alert(1)" }), "Open Link in New Tab");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs).toHaveLength(1);
  });

  test("View Page Source opens a view-source: tab on the page", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0]), "View Page Source");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs[1].url).toBe("view-source:https://example.com/");
  });

  test("a selection ALWAYS searches, even when it reads like an address", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    pick(rightClick(harness, harness.views[0], { selectionText: "example.org" }), "Search the web for “example.org”");
    await harness.manager.settlePopupTabs();
    expect(harness.manager.state("session-a").tabs[1].url).toBe("https://www.google.com/search?q=example.org");
  });

  test("the edit verbs and the spelling fix reach the page's own WebContents", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const wc = harness.views[0].webContents;
    const editable = { isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive"] };
    pick(rightClick(harness, harness.views[0], editable), "receive");
    pick(rightClick(harness, harness.views[0], { isEditable: true }), "Paste");
    pick(rightClick(harness, harness.views[0], { hasImageContents: true, srcURL: "https://example.com/cat.png", x: 5, y: 7 }), "Copy Image");
    pick(rightClick(harness, harness.views[0], { hasImageContents: true, srcURL: "https://example.com/cat.png" }), "Save Image As…");
    expect(wc.edits).toEqual(["replace:receive", "paste", "copy-image:5,7"]);
    expect(wc.downloads).toEqual(["https://example.com/cat.png"]);
  });

  test("a right-click is a human's hand on the tab before any row is picked", async () => {
    const harness = makeHarness();
    await harness.manager.createTab("session-a", "https://example.com");
    const tab = harness.manager.state("session-a").tabs[0];
    expect(tab.controller).not.toBe("human");
    rightClick(harness, harness.views[0]);
    expect(harness.manager.state("session-a").tabs[0].controller).toBe("human");
  });
});

describe("downloads save straight to the Downloads folder", () => {
  function downloadItem(url, filename) {
    const done = [];
    return {
      savePath: null,
      getURL: () => url,
      getFilename: () => filename,
      setSavePath(target) { this.savePath = target; },
      getSavePath() { return this.savePath ?? ""; },
      once(event, listener) { if (event === "done") done.push(listener); },
      finish(state) { for (const listener of done) listener({}, state); },
    };
  }

  async function withTab() {
    const harness = makeHarness({ sessions: true });
    await harness.manager.createTab("session-a", "https://example.com");
    const tab = harness.manager.scopeTabs("session-a")[0];
    const wc = harness.views[0].webContents;
    wc.id = 41;
    return { ...harness, tab, wc, ses: harness.sessions.get(tab.partition) };
  }

  test("a link's download gets a path with no dialog, and the agent's console says where it landed", async () => {
    const { messages, tab, wc, ses } = await withTab();
    const item = downloadItem("https://example.com/report.pdf", "report.pdf");
    ses.download(item, wc);
    expect(item.savePath).toBe("/fixture/Downloads/report.pdf");
    item.finish("completed");
    expect(tab.console).toEqual([
      { level: "info", text: "Download started: report.pdf is being saved to /fixture/Downloads/report.pdf" },
      { level: "info", text: "Downloaded report.pdf to /fixture/Downloads/report.pdf" },
    ]);
    const pushed = messages.filter((message) => message.channel === "telar:browser:download").map((message) => message.payload);
    expect(pushed).toEqual([
      { scopeKey: "session-a", tabId: tab.id, state: "started", path: "/fixture/Downloads/report.pdf", filename: "report.pdf" },
      { scopeKey: "session-a", tabId: tab.id, state: "completed", path: "/fixture/Downloads/report.pdf", filename: "report.pdf" },
    ]);
  });

  test("a failed download is an error line, never a claim that a file is there", async () => {
    const { tab, wc, ses } = await withTab();
    const item = downloadItem("https://example.com/big.zip", "big.zip");
    ses.download(item, wc);
    item.finish("interrupted");
    expect(tab.console.at(-1)).toEqual({ level: "error", text: "Download of big.zip failed; nothing was saved to /fixture/Downloads/big.zip" });
  });

  test("Save Image As… still prompts — and only that once", async () => {
    const harness = await withTab();
    const cat = "https://example.com/cat.png";
    pick(rightClick(harness, harness.views[0], { hasImageContents: true, srcURL: cat }), "Save Image As…");
    expect(harness.wc.downloads).toEqual([cat]);
    const asked = downloadItem(cat, "cat.png");
    harness.ses.download(asked, harness.wc);

    expect(asked.savePath).toBeNull();

    const plain = downloadItem(cat, "cat.png");
    harness.ses.download(plain, harness.wc);
    expect(plain.savePath).toBe("/fixture/Downloads/cat.png");
  });
});

describe("the browser's options menu", () => {
  test("the zoom ladder is Chromium's, and it stops at both ends", () => {
    expect(zoomStep(1, "in")).toBe(1.1);
    expect(zoomStep(1, "out")).toBe(0.9);
    expect(zoomStep(1, "reset")).toBe(1);

    expect(zoomStep(1.2, "in")).toBe(1.25);
    expect(zoomStep(1.2, "out")).toBe(1.1);

    expect(zoomStep(ZOOM_STEPS.at(-1), "in")).toBe(ZOOM_STEPS.at(-1));
    expect(zoomStep(ZOOM_STEPS[0], "out")).toBe(ZOOM_STEPS[0]);

    expect(zoomStep(3.7, "reset")).toBe(1);
    expect(() => zoomStep(1, "sideways")).toThrow("Unknown zoom direction");
  });

  test("zoom walks the ladder on the page itself, and the panel reads it back", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const wc = views[0].webContents;

    await manager.action("session-a", { action: "zoom", direction: "in" });
    expect(wc.getZoomFactor()).toBe(1.1);
    expect(manager.state("session-a").tabs[0].zoom).toBe(1.1);

    await manager.action("session-a", { action: "zoom", direction: "in" });
    expect(manager.state("session-a").tabs[0].zoom).toBe(1.25);
    await manager.action("session-a", { action: "zoom", direction: "reset" });
    expect(wc.getZoomFactor()).toBe(1);
    expect(manager.state("session-a").tabs[0].zoom).toBe(1);
  });

  test("a zoomed tab is still zoomed after it is hibernated and woken", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const tab = manager.scopeTabs("session-a")[0];
    await manager.action("session-a", { action: "zoom", direction: "out" });
    expect(views[0].webContents.getZoomFactor()).toBe(0.9);

    manager.requestHibernate(tab);
    await manager.wakeTab(tab);
    await manager.applyGeometry(tab);
    expect(views.at(-1).webContents.getZoomFactor()).toBe(0.9);
    expect(manager.state("session-a").tabs[0].zoom).toBe(0.9);
  });

  test("hard reload is a cache bypass, not the ordinary reload with a flag", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const wc = views[0].webContents;

    await manager.action("session-a", { action: "reload" });
    await manager.action("session-a", { action: "hard-reload" });
    expect(wc.reloads).toEqual(["reload", "reload-ignoring-cache"]);

    expect(manager.state("session-a").tabs[0].controller).toBe("human");
  });

  test("appearance emulates prefers-color-scheme, and system clears the override", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const debug = views[0].webContents.debugger;
    const media = () => debug.commands.filter((entry) => entry.method === "Emulation.setEmulatedMedia");

    expect(media()).toEqual([]);

    await manager.action("session-a", { action: "appearance", scheme: "dark" });
    expect(media().at(-1).params).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] });
    expect(manager.state("session-a").tabs[0].colorScheme).toBe("dark");

    await manager.action("session-a", { action: "appearance", scheme: "system" });

    expect(media().at(-1).params).toEqual({ features: [] });
    expect(manager.state("session-a").tabs[0].colorScheme).toBe("system");

    await expect(manager.action("session-a", { action: "appearance", scheme: "sepia" })).rejects.toThrow("Unknown appearance");
  });

  test("appearance is re-applied to a tab's NEW WebContents, not lost with the old one", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    const tab = manager.scopeTabs("session-a")[0];
    await manager.action("session-a", { action: "appearance", scheme: "dark" });

    manager.requestHibernate(tab);
    await manager.wakeTab(tab);
    await manager.applyGeometry(tab);
    const media = views.at(-1).webContents.debugger.commands.filter((entry) => entry.method === "Emulation.setEmulatedMedia");
    expect(media.at(-1).params).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] });
  });

  describe("a tab in a window of its own", () => {
    async function shown() {
      const harness = makeHarness();
      await harness.manager.createTab("session-a", "https://example.com");
      harness.manager.setBounds("session-a", { x: 0, y: 0, width: 900, height: 600 });
      await harness.manager.setVisible("session-a", true);
      return harness;
    }

    test("the LIVE view moves out of the cockpit — a preview is the tab, not a copy of it", async () => {
      const { children, manager, previewWindows, views } = await shown();
      expect(children.has(views[0])).toBe(true);

      await manager.action("session-a", { action: "preview" });
      const window = previewWindows.at(-1);

      expect(views).toHaveLength(1);
      expect(children.has(views[0])).toBe(false);
      expect(window.children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(true);
    });

    test("it is sized to the page's own viewport and fills its window", async () => {
      const { manager, previewWindows, views } = await shown();

      expect(manager.state("session-a").tabs[0].viewport).toMatchObject({ width: 900, height: 600 });

      await manager.action("session-a", { action: "preview" });
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(previewWindows.at(-1).options).toMatchObject({ width: 900, height: 600, useContentSize: true });
      expect(views[0].visible).toBe(true);
      expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    test("the panel neither places nor hides a previewed tab — its own window would go blank", async () => {
      const { manager, views } = await shown();
      await manager.action("session-a", { action: "preview" });

      await manager.setVisible("session-a", false);
      manager.setBounds("session-a", { x: 0, y: 0, width: 400, height: 300 });
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(views[0].visible).toBe(true);

      expect(manager.state("session-a").tabs[0].viewport).toMatchObject({ width: 900, height: 600 });
    });

    test("closing the window is how the tab comes back", async () => {
      const { children, manager, previewWindows, views } = await shown();
      await manager.action("session-a", { action: "preview" });
      const window = previewWindows.at(-1);

      window.destroy();
      expect(children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(false);
      await manager.applyGeometry(manager.scopeTabs("session-a")[0]);
      expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    test("the panel can bring it back too, and asking twice only focuses the window", async () => {
      const { children, manager, previewWindows, views } = await shown();
      await manager.action("session-a", { action: "preview" });
      await manager.action("session-a", { action: "preview" });
      expect(previewWindows).toHaveLength(1);
      expect(previewWindows[0].focused).toBe(1);

      await manager.action("session-a", { action: "end-preview" });
      expect(previewWindows[0].isDestroyed()).toBe(true);
      expect(children.has(views[0])).toBe(true);
      expect(manager.state("session-a").tabs[0].preview).toBe(false);
    });

    test("closing the TAB takes its window with it — never a window addressing nothing", async () => {
      const { manager, previewWindows } = await shown();
      await manager.action("session-a", { action: "preview" });
      manager.closeTab("session-a", 0);
      expect(previewWindows[0].isDestroyed()).toBe(true);
    });

    test("an agent cannot open a window over the person's screen", async () => {
      const { manager, previewWindows } = await shown();
      await expect(manager.performAction("session-a", { action: "preview" })).rejects.toThrow("Unknown desktop browser action");
      expect(previewWindows).toHaveLength(0);
    });
  });

  describe("clearing this profile's cookies and cache", () => {
    test("the scope is the PARTITION — the whole identity, which is what the panel's confirm says", async () => {
      const { manager, sessions } = makeHarness({ sessions: true });
      await manager.createTab("session-a", "https://example.com");
      const partition = manager.scopeTabs("session-a")[0].partition;

      expect(await manager.clearBrowsingData("session-a", "cookies")).toMatchObject({ ok: true, kind: "cookies", partition });
      expect(sessions.get(partition).storageCleared).toEqual([{ storages: ["cookies"] }]);
      expect(sessions.get(partition).cachesCleared).toBe(0);

      expect(await manager.clearBrowsingData("session-a", "cache")).toMatchObject({ ok: true, kind: "cache", partition });
      expect(sessions.get(partition).cachesCleared).toBe(1);

      expect(sessions.get(partition).storageCleared).toHaveLength(1);
    });

    test("it refuses what it cannot do rather than reporting a clear that did not happen", async () => {
      const { manager } = makeHarness({ sessions: true });
      manager.declareProfile("session-a", "none");

      await expect(manager.clearBrowsingData("session-a", "cookies")).rejects.toThrow("no tab here");

      await manager.createTab("session-a", "https://example.com");
      await expect(manager.clearBrowsingData("session-a", "history")).rejects.toThrow("Unknown browsing data");
    });

    test("with no Chromium session to reach it says so — never a silent success", async () => {
      const { manager } = makeHarness();
      await manager.createTab("session-a", "https://example.com");
      await expect(manager.clearBrowsingData("session-a", "cookies")).rejects.toThrow("no Chromium session");
    });
  });
});
