const { describe, expect, test } = require("bun:test");

const { makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("navigation replacement — ERR_ABORTED from a superseded load is not a failure", () => {
  function replacing(views, finalUrl) {
    const wc = views[0].webContents;
    wc.loadURL = async function (url) {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`);
      error.errno = -3;
      error.code = "ERR_ABORTED";
      queueMicrotask(() => {
        this.url = finalUrl;
        this.title = "Landed";
        this.emit("did-navigate");
        this.emit("did-stop-loading");
      });
      throw error;
    };
    return wc;
  }

  test("a page that replaces its own load answers with the replacement's outcome, human and agent paths alike", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    replacing(views, "https://landed.example/");
    const state = await manager.action("s", { action: "navigate", url: "https://bounce.example/?themeRefresh=1" });
    expect(state.tabs[0].url).toBe("https://landed.example/");
    const result = await manager.callTool("s", "browser_navigate", { url: "https://bounce.example/?themeRefresh=1" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("landed.example");
  });

  test("an abort with NO replacement, and any other failure, still throws", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = views[0].webContents;
    wc.loadURL = async function () {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-stop-loading");
      const error = new Error("ERR_ABORTED (-3)");
      error.errno = -3;
      throw error;
    };
    wc.isLoading = () => false;
    await expect(manager.action("s", { action: "navigate", url: "https://stopped.example/" })).rejects.toThrow(/ERR_ABORTED/);
    wc.loadURL = async function () {
      const error = new Error("ERR_CONNECTION_REFUSED (-102)");
      error.errno = -102;
      throw error;
    };
    await expect(manager.action("s", { action: "navigate", url: "https://dead.example/" })).rejects.toThrow(/CONNECTION_REFUSED/);
  });

  test("a replacement that itself fails reports THAT failure", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = views[0].webContents;
    wc.loadURL = async function (url) {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`);
      error.errno = -3;
      queueMicrotask(() => this.emit("did-fail-load", null, -105, "ERR_NAME_NOT_RESOLVED", "https://nowhere.example/", true));
      throw error;
    };
    wc.isLoading = () => true;
    await expect(manager.action("s", { action: "navigate", url: "https://bounce.example/" })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe("the start page's contract — onVisited and the hidden blank view", () => {
  test("onVisited fires for a committed http(s) top-level navigation only: not blank, not an error status, not an extension page", async () => {
    const visited = [];
    const { manager, views } = makeHarness({ onVisited: (scopeKey, url) => visited.push([scopeKey, url]) });
    await manager.createTab("s", "https://one.example/");
    const wc = views[0].webContents;
    wc.url = "https://two.example/path"; wc.emit("did-navigate", null, "https://two.example/path", 200);
    wc.url = "https://err.example/"; wc.emit("did-navigate", null, "https://err.example/", 404);
    wc.url = "chrome-extension://abc/x.html"; wc.emit("did-navigate", null, "chrome-extension://abc/x.html", 200);
    wc.url = "about:blank"; wc.emit("did-navigate", null, "about:blank", 0);
    expect(visited).toEqual([["s", "https://one.example/"], ["s", "https://two.example/path"]]);
  });

  test("a blank active tab shows NO native view (the DOM start page is under it); a navigation reveals it", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank", "human");
    manager.setBounds("s", { x: 0, y: 0, width: 640, height: 400 });
    await manager.setVisible("s", true);
    const tab = manager.activeTab("s");
    await tab.geometry.queue;
    expect(views[0].visible).toBe(false);
    await manager.action("s", { action: "navigate", url: "https://one.example/" });
    await tab.geometry.queue;
    expect(views[0].visible).toBe(true);
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: 640, height: 400 });
  });
});

describe("navigation replacement — the waiter's endings", () => {
  function stalledReplacement(views) {
    const wc = views[0].webContents;
    wc.isLoading = () => true;
    wc.loadURL = async function () {
      this.emit("did-start-loading");
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      throw Object.assign(new Error("ERR_ABORTED (-3)"), { errno: -3 });
    };
    return wc;
  }
  const EVENTS = ["did-start-navigation", "did-navigate", "did-navigate-in-page", "did-fail-load", "did-stop-loading", "destroyed"];

  test("a replacement whose load STOPS before any commit is a failure, not a success", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const pending = manager.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc.emit("did-stop-loading");
    await expect(pending).rejects.toThrow(/stopped before a page committed/);
  });

  test("a tab closed mid-replacement rejects; a same-document replacement counts as a commit", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const closed = manager.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc.emit("destroyed");
    await expect(closed).rejects.toThrow(/closed while the page/);
    const { manager: m2, views: v2 } = makeHarness();
    await m2.createTab("s", "about:blank");
    const wc2 = stalledReplacement(v2);
    const inPage = m2.action("s", { action: "navigate", url: "https://bounce.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wc2.url = "https://bounce.example/#landed";
    wc2.emit("did-navigate-in-page");
    await expect(inPage).resolves.toBeTruthy();
  });

  test("the deadline rejects AND removes every listener it attached", async () => {
    const { manager, views } = makeHarness({ rpcTimeoutMs: 30 });
    await manager.createTab("s", "about:blank");
    const wc = stalledReplacement(views);
    const before = EVENTS.map((name) => wc.listenerCount(name));
    await expect(manager.action("s", { action: "navigate", url: "https://bounce.example/" })).rejects.toThrow(/never settled/);
    expect(EVENTS.map((name) => wc.listenerCount(name))).toEqual(before);
  });
});
