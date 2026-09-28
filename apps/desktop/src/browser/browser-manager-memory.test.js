const { describe, expect, test } = require("bun:test");

const { makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("what the main process holds — the heap log's counts (#296)", () => {
  test("diagnostics counts the live views, their listeners and every growing collection", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    await manager.createTab("s", "https://two.example/");

    const before = manager.diagnostics();
    expect(before).toMatchObject({ scopes: 1, tabs: 2, liveViews: 2, extensionHosts: 0 });

    expect(before.wcListeners).toBeGreaterThan(0);

    views[0].webContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }] });
    views[0].webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: "https://one.example/api" } });
    expect(manager.diagnostics()).toMatchObject({ consoleEntries: 1, networkEntries: 1 });

    manager.requestHibernate(manager.scopeTabs("s")[0]);
    const after = manager.diagnostics();
    expect(after.liveViews).toBe(1);
    expect(after.tabs).toBe(2);
    expect(after.wcListeners).toBeLessThan(before.wcListeners);
  });

  test("re-waking a tab does not leave a second set of listeners behind", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const tab = manager.scopeTabs("s")[0];
    const fresh = manager.diagnostics().wcListeners;

    for (let i = 0; i < 5; i += 1) {
      manager.requestHibernate(tab);
      await manager.wakeTab(tab);
    }
    expect(manager.diagnostics()).toMatchObject({ liveViews: 1, wcListeners: fresh });
  });
});

describe("the origins with a live page, per partition (#487)", () => {
  test("a live tab's origin answers for its partition; a hibernated one does not", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://github.com/facundo/telar");
    await manager.createTab("s", "https://www.youtube.com/watch?v=1");
    const partition = manager.partitionOf("s");

    expect(manager.liveOriginsByPartition().get(partition)).toEqual(
      new Set(["https://github.com", "https://www.youtube.com"]),
    );

    manager.requestHibernate(manager.scopeTabs("s")[0]);
    expect(manager.liveOriginsByPartition().get(partition)).toEqual(new Set(["https://www.youtube.com"]));

    manager.requestHibernate(manager.scopeTabs("s")[1]);
    expect(manager.liveOriginsByPartition().has(partition)).toBe(false);
  });

  test("a page with no origin of its own vouches for nothing", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "about:blank");
    expect(manager.liveOriginsByPartition().size).toBe(0);
  });

  test("the partitions to walk include one whose every tab has hibernated", async () => {
    const { manager } = makeHarness();
    await manager.createTab("s", "https://github.com/");
    const partition = manager.partitionOf("s");
    manager.requestHibernate(manager.scopeTabs("s")[0]);

    expect(manager.activePartitions().has(partition)).toBe(true);
  });
});

describe("the main process holds a bounded amount (#296)", () => {
  test("a captured console line is bounded in BYTES, not only in count", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    const tab = manager.activeTab("s");

    debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "x".repeat(5_000_000) }] });
    expect(tab.console).toHaveLength(1);
    expect(tab.console[0].text.length).toBeLessThan(2_100);

    expect(tab.console[0].text).toContain("truncated");

    debug.emit("message", {}, "Log.entryAdded", { entry: { level: "error", text: "y".repeat(4_000) } });
    expect(tab.console[1].text.length).toBeLessThan(2_100);

    debug.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: `data:image/png;base64,${"A".repeat(3_000_000)}` } });
    expect(tab.network[0].url.length).toBeLessThan(2_100);
  });

  test("the capture keeps the newest 200 and drops the oldest, in place", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://one.example/");
    const debug = views[0].webContents.debugger;
    const tab = manager.activeTab("s");
    const before = tab.console;

    for (let i = 0; i < 250; i += 1) {
      debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: `line ${i}` }] });
      debug.emit("message", {}, "Network.requestWillBeSent", { request: { method: "GET", url: `https://one.example/${i}` } });
    }
    expect(tab.console).toHaveLength(200);
    expect(tab.network).toHaveLength(200);
    expect(tab.console[0].text).toBe("line 50");
    expect(tab.console.at(-1).text).toBe("line 249");

    expect(tab.console).toBe(before);
  });

  test("an agent expectation whose echo never arrives expires instead of accumulating", async () => {
    const clock = { t: 1_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");

    for (let i = 0; i < 50; i += 1) {
      clock.t += 100;
      manager.stampAgentInput(tab, 1);
    }

    expect(tab.expectedReports.length).toBeLessThanOrEqual(21);

    clock.t += 10_000;
    manager.stampAgentInput(tab, 1);
    expect(tab.expectedReports).toEqual([clock.t]);
  });

  test("an expectation still swallows the agent's own echo within its TTL", async () => {
    const clock = { t: 1_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://one.example/");
    const tab = manager.activeTab("s");

    manager.stampAgentInput(tab, 1);
    clock.t += 200;

    expect(manager.noteHumanInput("s", { tab })).toBe(false);

    clock.t += 500;
    expect(manager.noteHumanInput("s", { tab })).toBe(true);
  });

  test("a destroyed scope leaves nothing keyed by it behind", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");
    manager.setBounds("s", { x: 0, y: 0, width: 800, height: 600 });
    manager.stampAgentInput(manager.activeTab("s"), 1);
    expect(manager.diagnostics().scopeEntries).toBeGreaterThan(0);

    manager.releaseScope("s", true);

    expect(manager.diagnostics()).toMatchObject({ scopes: 0, tabs: 0, scopeEntries: 0 });
    expect(manager.scopeProfiles.has("s")).toBe(false);
    expect(manager.scopeProjects.has("s")).toBe(false);
    expect(manager.boundsByScope.has("s")).toBe(false);
    expect(manager.lastAgentInputAt.has("s")).toBe(false);
  });

  test("a release that is not a destroy keeps the scope's binding — its tabs are only asleep", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");

    manager.releaseScope("s");

    expect(manager.profileOf("s")).toBe("none");
    expect(manager.scopeTabs("s")).toHaveLength(1);
    expect(manager.diagnostics()).toMatchObject({ tabs: 1, liveViews: 0 });
  });

  test("the person closing the browser destroys the agent's pages and its next call says so", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/", "human");
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example/" });

    manager.releaseScope("s", true, { closedByPerson: true });

    expect(manager.scopeTabs("s")).toHaveLength(0);

    expect(manager.profileOf("s")).toBe("none");
    for (const [name, args] of [
      ["browser_navigate", { url: "https://three.example/" }],
      ["browser_snapshot", {}],
      ["browser_tabs", { action: "list" }],
    ]) {
      const result = await manager.callTool("s", name, args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("The person closed the browser for this session");
      expect(textOf(result)).toContain("browser_tabs new");
    }

    expect(manager.scopeTabs("s")).toHaveLength(0);

    const reopened = await manager.callTool("s", "browser_tabs", { action: "new", url: "https://four.example/" });
    expect(reopened.isError).toBeFalsy();
    expect(manager.scopeTabs("s").map((tab) => tab.url)).toEqual(["https://four.example/"]);
    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(listed.isError).toBeFalsy();
  });

  test("the person reopening the browser clears the closed mark too", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/", "agent");
    manager.releaseScope("s", true, { closedByPerson: true });

    await manager.createTab("s", "https://two.example/", "human");

    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(listed.isError).toBeFalsy();
  });

  test("closing a Browser that had no pages leaves the agent nothing to be told", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    manager.releaseScope("s", true, { closedByPerson: true });

    const result = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(textOf(result)).not.toContain("The person closed the browser");
  });

  test("a destroying release that is not the person's says nothing to the agent", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "none");
    await manager.createTab("s", "https://one.example/");
    manager.releaseScope("s", true);

    const result = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(textOf(result)).not.toContain("The person closed the browser");
  });

  test("adopting a scope's tabs forgets the scope they came from", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("from", "none");
    await manager.createTab("from", "https://one.example/");
    manager.setBounds("from", { x: 0, y: 0, width: 800, height: 600 });

    manager.adoptScope("from", "to");

    expect(manager.scopeTabs("to")).toHaveLength(1);
    expect(manager.profileOf("to")).toBe("none");

    expect(manager.scopeProfiles.has("from")).toBe(false);
    expect(manager.scopeProjects.has("from")).toBe(false);
    expect(manager.boundsByScope.has("from")).toBe(false);
    expect(manager.diagnostics().scopes).toBe(1);
  });

  test("the inventory is walked once per turn, not once per page event", async () => {
    let walks = 0;
    const { manager } = makeHarness();
    manager.tabStore = { load: () => null, save: () => {}, flushSync: () => {} };
    await manager.createTab("s", "https://one.example/");
    const inventory = manager.inventory.bind(manager);
    manager.inventory = () => { walks += 1; return inventory(); };

    const wc = manager.activeTab("s").view.webContents;
    wc.emit("did-start-loading");
    wc.emit("page-title-updated", {}, "One");
    wc.emit("page-favicon-updated", {}, ["https://one.example/f.ico"]);
    wc.emit("did-navigate-in-page");
    wc.emit("did-stop-loading");
    expect(walks).toBe(0);

    await Promise.resolve();
    expect(walks).toBe(1);
  });
});
