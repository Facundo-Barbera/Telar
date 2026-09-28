const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager, normalizeUrl, looksLikeAddress, TAB_SELECT_CHORDS } = require("./browser-manager");
const { FakeView, makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("normalizeUrl", () => {
  test("normalizes local addresses without accepting non-web protocols", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("https://example.com/path")).toBe("https://example.com/path");

    expect(normalizeUrl("file:///tmp/example.html")).toBe("file:///tmp/example.html");

    expect(normalizeUrl("/tmp/my guide.html")).toBe("file:///tmp/my%20guide.html");

    expect(() => normalizeUrl("smb://server/share")).toThrow("only opens http, https and file URLs");
    expect(() => normalizeUrl("javascript://alert(1)")).toThrow("only opens http, https and file URLs");
  });
});

describe("the address bar tells an address from words to search for", () => {
  test("an address is a path, a scheme, or a host with no whitespace", () => {
    expect(looksLikeAddress("github.com")).toBe(true);
    expect(looksLikeAddress("localhost:3000")).toBe(true);
    expect(looksLikeAddress("localhost")).toBe(true);
    expect(looksLikeAddress("127.0.0.1")).toBe(true);
    expect(looksLikeAddress("[::1]:8080")).toBe(true);

    expect(looksLikeAddress("https://x")).toBe(true);
    expect(looksLikeAddress("file:///tmp/a")).toBe(true);

    expect(looksLikeAddress("/tmp/my guide.html")).toBe(true);
  });
  test("words are words — the cases that used to surface 'Invalid URL'", () => {
    expect(looksLikeAddress("hello world")).toBe(false);
    expect(looksLikeAddress("telar")).toBe(false);
    expect(looksLikeAddress("what is 2+2")).toBe(false);
    expect(looksLikeAddress("")).toBe(false);
  });
  test("normalizeUrl searches for what is not an address, and encodes it", () => {
    expect(normalizeUrl("hello world")).toBe("https://www.google.com/search?q=hello%20world");
    expect(normalizeUrl("telar")).toBe("https://www.google.com/search?q=telar");

    expect(normalizeUrl("what is 2+2")).toBe("https://www.google.com/search?q=what%20is%202%2B2");

    expect(normalizeUrl("github.com")).toBe("http://github.com/");
    expect(normalizeUrl("127.0.0.1")).toBe("http://127.0.0.1/");
    expect(normalizeUrl("https://x")).toBe("https://x/");

    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });
});

describe("DesktopBrowserManager", () => {
  test("owns tab visibility and bounds without an Electron process", async () => {
    const { children, manager, views } = makeHarness();

    await manager.createTab("session-a", "localhost:3000");
    manager.setBounds("session-a", { x: 10.4, y: 20.6, width: 800.2, height: 600.8 });
    await manager.setVisible("session-a", true);

    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ id: "tab-1", url: "http://localhost:3000/", active: true }),
    ]);
    expect(views[0].visible).toBe(true);

    expect(views[0].bounds).toEqual({ x: 10, y: 21, width: 800, height: 601 });
    expect(manager.state("session-a").tabs[0].viewport).toEqual({ width: 800, height: 601, preset: null, mode: "fit" });
    expect(children.size).toBe(1);

    manager.destroy();
    expect(children.size).toBe(0);
    expect(views[0].webContents.destroyed).toBe(true);
  });

  test("a renderer reload HIDES the visible scope and keeps its page alive — never a release", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://example.com");
    await manager.setVisible("session-a", true);

    expect(() => manager.hideVisibleScope()).not.toThrow();
    expect(manager.visibleScopeKey).toBeNull();
    expect(views[0].visible).toBe(false);

    expect(children.size).toBe(1);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ url: "https://example.com/", active: true, sleeping: false }),
    ]);
  });

  test("opens target-blank web links as managed browser tabs, adopting Chromium's own popup", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://one.example/", "human");

    const response = views[0].webContents.openWindow("https://popup.example/path");
    expect(response.action).toBe("allow");

    expect(response.adopted).toBe(views[1].webContents);
    expect(views[1].webContents.opener).toBe(views[0].webContents);

    expect(response.outlivesOpener).toBe(true);
    await manager.settlePopupTabs();

    const state = manager.state("session-a");
    expect(state.tabs.map((tab) => [tab.url, tab.active, tab.agentFocus, tab.openedBy])).toEqual([
      ["https://one.example/", false, false, "human"],
      ["https://popup.example/path", true, true, "human"],
    ]);
  });

  test("a popup keeps the OPENER's profile, not whichever one the session switched to", async () => {
    const { manager, views } = makeHarness();
    manager.declareProfile("session-a", `project_${"a".repeat(32)}`);
    await manager.createTab("session-a", "https://one.example/", "human");
    const opener = manager.scopeTabs("session-a")[0];

    const other = manager.profiles.create({ label: "Personal" });
    manager.setScopeProfile("session-a", other.id);

    views[0].webContents.openWindow("https://popup.example/oauth");
    await manager.settlePopupTabs();

    const popup = manager.scopeTabs("session-a")[1];
    expect(popup.partition).toBe(opener.partition);
    expect(popup.profileId).toBe(opener.profileId);
    expect(popup.partition).not.toBe(manager.partitionOf("session-a"));
  });

  test("a popup past the per-session tab limit is refused, and opens nothing", async () => {
    const { manager, views } = makeHarness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("session-a", `https://tab${i}.example/`, "human");

    expect(views[0].webContents.openWindow("https://popup.example/oauth")).toEqual({ action: "deny" });
    await manager.settlePopupTabs();

    expect(manager.state("session-a").tabs).toHaveLength(12);
  });

  test("keeps agent-triggered popups off the human's current browser tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://human.example/", "human");
    await manager.createTab("session-a", "https://agent.example/", "agent");
    const agentTab = manager.scopeTabs("session-a")[1];
    agentTab.agentBusy = 1;

    expect(views[1].webContents.openWindow("https://popup.example/oauth").action).toBe("allow");
    await manager.settlePopupTabs();
    agentTab.agentBusy = 0;

    const state = manager.state("session-a");
    expect(state.tabs.map((tab) => [tab.url, tab.active, tab.agentFocus, tab.openedBy])).toEqual([
      ["https://human.example/", true, false, "human"],
      ["https://agent.example/", false, false, "agent"],
      ["https://popup.example/oauth", false, true, "agent"],
    ]);
  });

  test("refuses protected and non-web popup targets without creating a browser tab", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("session-a", "https://one.example/", "human");

    for (const target of ["chrome-extension://abc/popup.html", "chrome://extensions", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(views[0].webContents.openWindow(target)).toEqual({ action: "deny" });
    }
    await manager.settlePopupTabs();

    expect(manager.state("session-a").tabs).toHaveLength(1);
  });

  test("an agent action in flight across a renderer reload finishes on the same page", async () => {
    let releaseWait;
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    const { manager, views } = makeHarness({ wait: async () => { enteredWait(); await gate; } });
    await manager.createTab("session-a", "https://a.example");
    await manager.setVisible("session-a", true);
    await manager.callTool("session-a", "browser_snapshot");
    const click = manager.callTool("session-a", "browser_click", { target: "e1", element: "Count 0 button" });
    await waiting;

    manager.hideVisibleScope();
    releaseWait();
    const result = await click;
    expect(result.isError).toBeFalsy();
    expect(views[0].webContents.destroyed).toBe(false);
    expect(views[0].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed")).toBe(true);
  });

  test("conversation switches hide without destroying the session browser", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://a.example");
    await manager.setVisible("session-a", true);

    await manager.setVisible("session-a", false);
    expect(views[0].visible).toBe(false);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(children.size).toBe(1);

    await manager.createTab("session-b", "https://b.example");
    await manager.setVisible("session-b", true);
    expect(textOf(await manager.callTool("session-a", "browser_tabs", { action: "list" })))
      .toContain("https://a.example/");

    await manager.setVisible("session-b", false);
    await manager.setVisible("session-a", true);
    expect(views[0].visible).toBe(true);
    expect(views[0].webContents.destroyed).toBe(false);
  });

  test("hiding for an open menu and showing on close keeps the page and its rect", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a", "https://a.example");
    manager.setBounds("session-a", { x: 40, y: 80, width: 900, height: 600 });
    await manager.setVisible("session-a", true);
    const placed = views[0].bounds;
    expect(placed).toBeTruthy();

    await manager.setVisible("session-a", false);
    expect(views[0].visible).toBe(false);
    expect(views[0].webContents.destroyed).toBe(false);
    expect(children.size).toBe(1);

    await manager.setVisible("session-a", true);
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual(placed);
    expect(views[0].webContents.getURL()).toBe("https://a.example/");
  });

  test("returning to a budget-hibernated conversation recreates its rendered view", async () => {
    const { children, manager, views } = makeHarness({ maxLiveViews: 1 });
    await manager.createTab("session-a", "https://a.example");
    await manager.createTab("session-b", "https://b.example");
    expect(views[0].webContents.destroyed).toBe(true);

    await manager.setVisible("session-a", true);
    expect(children.size).toBe(1);
    expect(views[2].visible).toBe(true);
    expect(views[2].webContents.getURL()).toBe("https://a.example/");
  });

  test("the live-view budget cannot hibernate a background browser tool call", async () => {
    let releaseWait;
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    const { manager, views } = makeHarness({
      maxLiveViews: 1,
      wait: async () => {
        enteredWait();
        await gate;
      },
    });
    await manager.createTab("session-a", "https://a.example");
    await manager.callTool("session-a", "browser_snapshot");
    const click = manager.callTool("session-a", "browser_click", {
      target: "e1",
      element: "Count 0 button",
    });
    await waiting;

    await manager.setVisible("session-a", false);
    await manager.createTab("session-b", "https://b.example");
    expect(views[0].webContents.destroyed).toBe(false);

    releaseWait();
    expect((await click).isError).not.toBe(true);
  });

  test("does not close a view while navigation is still loading", async () => {
    const { children, manager, views } = makeHarness();
    await manager.createTab("session-a");
    await manager.setVisible("session-a", true);
    let finishLoad;
    views[0].webContents.loadGate = new Promise((resolve) => { finishLoad = resolve; });

    const navigation = manager.action("session-a", {
      action: "navigate",
      url: "https://www.youtube.com/",
    });
    manager.releaseScope("session-a");

    expect(views[0].webContents.destroyed).toBe(false);
    expect(views[0].visible).toBe(false);

    finishLoad();
    await navigation;

    expect(views[0].webContents.destroyed).toBe(true);
    expect(children.size).toBe(0);
    expect(manager.state("session-a").tabs).toEqual([
      expect.objectContaining({ url: "https://www.youtube.com/", active: true }),
    ]);
  });

  test("exposes accessibility refs and preserves cursor timing around clicks", async () => {
    const { manager, messages, views, waits } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    const snapshot = await manager.callTool("session-a", "browser_snapshot");
    expect(textOf(snapshot)).toContain('button "Count 0" [ref=e1]');

    const clicked = await manager.callTool("session-a", "browser_click", {
      target: "e1",
      element: "Count 0 button",
    });

    expect(clicked.isError).not.toBe(true);
    expect(waits).toEqual([160, 40]);
    expect(
      messages
        .filter((message) => message.channel === "telar:browser:pointer")
        .map((message) => message.payload.phase),
    ).toEqual(["move", "click"]);
    expect(
      views[0].webContents.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params.type),
    ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  test("snapshot narrows to a ref's subtree, and refuses a ref it never minted", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    expect(textOf(await manager.callTool("session-a", "browser_snapshot"))).toContain('button "Count 0" [ref=e1]');
    const narrowed = await manager.callTool("session-a", "browser_snapshot", { target: "e1" });
    expect(narrowed.isError).toBeUndefined();

    expect(textOf(narrowed)).toContain('button "Count 0" [ref=e1]');

    expect(textOf(narrowed)).toContain("Page: Fixture");
    expect(textOf(narrowed)).not.toContain("- RootWebArea");
    expect(textOf(await manager.callTool("session-a", "browser_snapshot"))).toContain("- RootWebArea");

    expect((await manager.callTool("session-a", "browser_click", { target: "e1" })).isError).toBeUndefined();

    await manager.callTool("session-a", "browser_snapshot");
    const unknown = await manager.callTool("session-a", "browser_snapshot", { target: "e404" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown browser target e404");
  });

  test("snapshot depth stops at a level; console level is a floor the host now honours", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://example.com");

    const shallow = await manager.callTool("session-a", "browser_snapshot", { depth: 0 });
    expect(textOf(shallow)).toContain("Fixture");
    expect(textOf(shallow)).not.toContain("Count 0");
    expect(textOf(await manager.callTool("session-a", "browser_snapshot", { depth: 1 }))).toContain("Count 0");

    const tab = manager.scopeTabs(manager.requireScope("session-a"))[0];
    tab.console.push({ level: "debug", text: "chatter" }, { level: "error", text: "boom" });
    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { level: "error" }))).toBe("[error] boom");

    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { level: "info" }))).not.toContain("chatter");
    expect(textOf(await manager.callTool("session-a", "browser_console_messages", { all: true }))).toContain("chatter");
  });

  test("returns a bounded tool error for stale accessibility refs", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "about:blank");

    const unseen = await manager.callTool("session-a", "browser_click", { target: "e404" });
    expect(unseen.isError).toBe(true);
    expect(textOf(unseen)).toContain("Take a fresh snapshot or screenshot");

    await manager.callTool("session-a", "browser_snapshot", {});
    const result = await manager.callTool("session-a", "browser_click", { target: "e404" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Take a fresh browser_snapshot first");
  });

  test("never exposes tabs across browser session scopes", async () => {
    const { manager } = makeHarness();
    await manager.createTab("session-a", "https://a.example");

    expect(textOf(await manager.callTool("session-b", "browser_tabs", { action: "list" })))
      .toBe("No browser tabs are open in this session.");
    const denied = await manager.callTool("session-b", "browser_snapshot");
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("Open a browser tab");

    await manager.createTab("session-b", "https://b.example");
    expect(manager.state("session-a").tabs.map((tab) => tab.url)).toEqual(["https://a.example/"]);
    expect(manager.state("session-b").tabs.map((tab) => tab.url)).toEqual(["https://b.example/"]);
  });

  test("hibernates inactive views, bounds live renderers, and adopts draft scopes", async () => {
    const { children, manager, views } = makeHarness({ maxLiveViews: 2 });
    await manager.createTab("draft", "https://one.example");
    await manager.createTab("other", "https://two.example");
    await manager.createTab("third", "https://three.example");

    expect(children.size).toBe(2);
    expect(views.filter((view) => !view.webContents.destroyed)).toHaveLength(2);
    manager.adoptScope("draft", "session-a");
    expect(manager.state("draft").tabs).toHaveLength(0);
    expect(manager.state("session-a").tabs.map((tab) => tab.url)).toEqual(["https://one.example/"]);

    manager.releaseScope("session-a", true);
    expect(manager.state("session-a").tabs).toHaveLength(0);
  });
});

describe("the persisted tab inventory — the manager owns tab lifetime across reload and restart", () => {
  const PROJECT = "project_0123456789abcdef0123456789abcdef";
  function memoryStore(initial = null) {
    const writes = [];
    return {
      writes,
      load: () => initial,
      save: (doc) => writes.push(doc),
      flushSync: (doc) => writes.push({ ...doc, sync: true }),
      latest: () => writes.at(-1),
    };
  }

  const settled = () => Promise.resolve();
  function harnessWith(tabStore, options = {}) {
    const views = [];
    let nextId = 1;
    const window = { isDestroyed: () => false, webContents: { send: () => {} }, contentView: { addChildView: () => {}, removeChildView: () => {} } };
    const manager = new DesktopBrowserManager(window, {
      createId: () => `tab-${nextId++}`,
      createView: () => { const view = new FakeView(); views.push(view); return view; },
      wait: async () => {},
      tabStore,
      ...options,
    });
    manager.ensureAutoRelease = () => {};
    return { manager, views };
  }

  test("every emitted change is remembered: order, active tab, opener, viewport — and closing a tab drops it (no resurrection)", async () => {
    const store = memoryStore();
    const { manager } = harnessWith(store);
    manager.declareProfile("s1", PROJECT);
    await manager.createTab("s1", "https://one.example/", "human");
    await manager.createTab("s1", "https://two.example/");

    await manager.resizeTab(manager.scopeTabs("s1")[1], { preset: "phone" });
    await manager.selectTab("s1", 0);
    let doc = store.latest();
    expect(doc.scopes.s1.projectKey).toBe(PROJECT);
    expect(doc.scopes.s1.activeTabId).toBe("tab-1");
    expect(doc.scopes.s1.tabs.map((tab) => [tab.id, tab.url, tab.openedBy, tab.viewport])).toEqual([
      ["tab-1", "https://one.example/", "human", undefined],
      ["tab-2", "https://two.example/", "agent", { width: 390, height: 844 }],
    ]);
    manager.closeTab("s1", 1);
    await settled();
    doc = store.latest();
    expect(doc.scopes.s1.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  });

  test("a restart restores the inventory LAZILY: records with no WebContents, in their profile's partition, loaded on first use only", async () => {
    const remembered = {
      version: 1,
      savedAt: 1,
      scopes: {
        s1: {
          profileKey: PROJECT,
          activeTabId: "b",
          tabs: [
            { id: "a", url: "https://one.example/", title: "One", openedBy: "human" },
            { id: "b", url: "https://two.example/", title: "Two", openedBy: "agent", viewport: { width: 768, height: 1024 } },
          ],
        },
        s2: { profileKey: "none", activeTabId: "c", tabs: [{ id: "c", url: "https://three.example/", title: "Three", openedBy: "agent" }] },
      },
    };
    const { manager, views } = harnessWith(memoryStore(remembered));

    expect(views).toHaveLength(0);
    expect(manager.profileOf("s1")).toBe(PROJECT);
    expect(manager.profileOf("s2")).toBe("none");
    const state = manager.state("s1");
    expect(state.tabs.map((tab) => [tab.id, tab.url, tab.title, tab.active, tab.sleeping, tab.openedBy])).toEqual([
      ["a", "https://one.example/", "One", false, true, "human"],
      ["b", "https://two.example/", "Two", true, true, "agent"],
    ]);
    expect(state.tabs[1].viewport).toEqual({ width: 768, height: 1024, preset: "ipad-mini", mode: "fixed" });

    const fallback = manager.profiles.get(manager.profiles.defaultProfileId).partition;
    expect(manager.scopeTabs("s1").every((tab) => tab.partition === fallback)).toBe(true);
    expect(manager.scopeTabs("s2")[0].partition).toBe(fallback);

    const listed = textOf(await manager.callTool("s1", "browser_snapshot", {}));
    expect(listed).toContain("https://two.example/");
    expect(views).toHaveLength(1);
    expect(views[0].webContents.getURL()).toBe("https://two.example/");
    expect(manager.state("s1").tabs.map((tab) => tab.sleeping)).toEqual([true, false]);

    const override = views[0].webContents.debugger.commands.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(override.params).toMatchObject({ width: 768, height: 1024 });
  });

  test("a remembered scope is never re-bound to a different profile — the fail-closed rule holds after a restart too", () => {
    const { manager } = harnessWith(memoryStore({
      version: 1, savedAt: 1,
      scopes: { s1: { profileKey: PROJECT, activeTabId: "a", tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "agent" }] } },
    }));
    expect(() => manager.declareProfile("s1", "none")).toThrow(/already has tabs in profile/);
    expect(manager.declareProfile("s1", PROJECT).partition).toBe(manager.profiles.get(manager.profiles.defaultProfileId).partition);
  });

  test("a legacy-owner mapping change at restart drops the scope rather than landing it in another project's jar", () => {
    const { manager } = harnessWith(memoryStore({
      version: 1, savedAt: 1,
      scopes: { s1: { profileKey: "legacy", activeTabId: "a", tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "agent" }] } },
    }), { profileMapping: { legacyOwnerProjectId: null } });
    expect(manager.scopeTabs("s1")).toEqual([]);
    expect(manager.profileOf("s1")).toBeNull();
  });

  test("destroy writes the inventory synchronously before the views go, with each live view's current URL", async () => {
    const store = memoryStore();
    const { manager, views } = harnessWith(store);
    manager.declareProfile("s1", "none");
    await manager.createTab("s1", "https://one.example/");

    views[0].webContents.url = "https://one.example/after-redirect";
    manager.destroy();
    const last = store.latest();
    expect(last.sync).toBe(true);
    expect(last.scopes.s1.tabs[0].url).toBe("https://one.example/after-redirect");

    const count = store.writes.length;
    manager.persist();
    expect(store.writes.length).toBe(count);
  });
});

describe("duplicating a tab", () => {
  test("it opens a second tab at the same address, and the source is left exactly where it was", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");

    await manager.action("s", { action: "duplicate", index: 0 });

    const tabs = manager.state("s").tabs;
    expect(tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/", "https://one.example/"]);

    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);

    expect(tabs[2].active).toBe(true);
    expect(tabs[2].openedBy).toBe("human");
  });

  test("with no index it duplicates the tab you are looking at", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await manager.selectTab("s", 0);

    await manager.action("s", { action: "duplicate" });

    expect(manager.state("s").tabs.map((tab) => tab.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
      "https://one.example/",
    ]);
  });

  test("it duplicates where the tab IS, not where its record last said it was", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    views[0].webContents.url = "https://one.example/deep/page";

    await manager.action("s", { action: "duplicate", index: 0 });
    expect(manager.state("s").tabs[1].url).toBe("https://one.example/deep/page");
  });

  test("an index that names no tab is refused, rather than duplicating something else", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/", "human");
    await expect(manager.action("s", { action: "duplicate", index: 9 })).rejects.toThrow(/does not exist/);
    expect(manager.state("s").tabs).toHaveLength(1);
  });
});

describe("view-source: is the one non-web scheme the tabs render", () => {
  test("it wraps an ordinary web page, and refuses anything else", () => {
    expect(normalizeUrl("view-source:https://example.com/a")).toBe("view-source:https://example.com/a");
    expect(normalizeUrl("view-source:http://localhost:3000/")).toBe("view-source:http://localhost:3000/");

    expect(() => normalizeUrl("view-source:file:///etc/passwd")).toThrow("only views the source of http and https");
    expect(() => normalizeUrl("view-source:view-source:https://example.com/")).toThrow("only views the source of http and https");
    expect(() => normalizeUrl("view-source:not a url")).toThrow("only views the source of http and https");
  });
});

describe("a focused page owns ⌘1..⌘9 (#660)", () => {
  function press(view, key, modifiers = { meta: true }) {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    view.webContents.emit("before-input-event", event, { type: "keyDown", key, alt: false, shift: false, control: false, meta: false, ...modifiers });
    return prevented;
  }

  async function withTabs(count) {
    const scopes = [];
    const harness = makeHarness({ onChordScope: (chords) => scopes.push(chords) });
    harness.manager.declareProfile("s1", "none");
    for (let n = 0; n < count; n += 1) await harness.manager.createTab("s1", `https://${n}.example/`, "human");
    return { ...harness, scopes };
  }

  test("focus claims the nine and blur gives them back — the menu only stands down while a page holds them", async () => {
    const { manager, views, scopes } = await withTabs(2);
    expect(scopes).toEqual([]);

    views[0].webContents.emit("focus");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);

    views[0].webContents.emit("blur");
    expect(scopes.at(-1)).toEqual([]);

    expect(manager.keyFocusedTabId).toBeNull();
  });

  test("⌘2 selects the second tab and the page never sees the key", async () => {
    const { manager, views } = await withTabs(3);
    await manager.selectTab("s1", 0);
    views[0].webContents.emit("focus");

    expect(press(views[0], "2")).toBe(true);
    await Promise.resolve();
    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(1);
  });

  test("⌃2 works too, and a digit past the last tab is left for the page", async () => {
    const { manager, views } = await withTabs(2);
    await manager.selectTab("s1", 0);

    expect(press(views[0], "2", { control: true })).toBe(true);
    await Promise.resolve();
    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(1);

    expect(press(views[0], "7")).toBe(false);
  });

  test("⌥⌘1, ⇧⌘1, a bare 1 and a keyUp are all somebody else's", async () => {
    const { manager, views } = await withTabs(3);
    await manager.selectTab("s1", 2);
    for (const input of [{ meta: true, alt: true }, { meta: true, shift: true }, {}]) {
      expect(press(views[0], "1", input)).toBe(false);
    }
    let prevented = false;
    views[0].webContents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { type: "keyUp", key: "1", meta: true });
    expect(prevented).toBe(false);

    expect(manager.scopeTabs("s1").indexOf(manager.activeTab("s1"))).toBe(2);
  });

  test("a second tab taking focus does not let the first one's late blur release the claim", async () => {
    const { views, scopes } = await withTabs(2);
    views[0].webContents.emit("focus");

    views[1].webContents.emit("focus");
    views[0].webContents.emit("blur");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);
  });

  test("closing the focused tab releases the claim — a destroyed page emits no blur", async () => {
    const { manager, views, scopes } = await withTabs(2);
    views[1].webContents.emit("focus");
    expect(scopes.at(-1)).toEqual(TAB_SELECT_CHORDS);
    manager.closeTab("s1", 1);

    expect(scopes.at(-1)).toEqual([]);
  });
});
