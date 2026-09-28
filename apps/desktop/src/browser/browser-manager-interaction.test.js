const { describe, expect, test } = require("bun:test");

const { makeHarness, textOf } = require("../../test/browser-manager-harness");
describe("the shared-browser interaction model — human input wins, agent defers then looks again", () => {
  function harness(options = {}) {
    const clock = { t: 1_000_000 };
    const changes = [];
    const base = makeHarness({
      ...options,
      now: () => clock.t,
      onControlChanged: (change) => changes.push(change),

      wait: async (ms) => {
        clock.t += ms;
      },
    });
    return { ...base, clock, changes };
  }
  async function observed(manager, scope = "s") {
    const result = await manager.callTool(scope, "browser_snapshot", {});
    expect(result.isError).toBeUndefined();
  }

  test("a fresh tab needs one look before its first mutation; reads never gate", async () => {
    const { manager, changes } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    const unseen = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(unseen.isError).toBe(true);

    await manager.callTool("s", "browser_console_messages", {});
    expect((await manager.callTool("s", "browser_click", { target: "e1" })).isError).toBe(true);
    const snap = await manager.callTool("s", "browser_snapshot", {});
    expect(snap.isError).toBeUndefined();
    const clicked = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(clicked.isError).toBeUndefined();
    expect(changes[0]).toMatchObject({ controller: "agent" });
  });

  test("human input bumps the generation: the next mutation is refused as STALE until the agent looks again — nothing replays", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    clock.t += 10_000;
    expect(manager.noteHumanInput("s")).toBe(true);
    clock.t += 2_000;
    const before = views[0].webContents.debugger.commands.length;
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you last looked");
    expect(textOf(stale)).toContain("the human interacted");

    expect(views[0].webContents.debugger.commands.slice(before).filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(0);
    await observed(manager);
    const fresh = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(fresh.isError).toBeUndefined();
  });

  test("while the human is actively interacting the mutation DEFERS, then proceeds once they stop", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    await observed(manager);
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(result.isError).toBeUndefined();

    expect(clock.t - t0).toBeGreaterThanOrEqual(1_500);
    expect(clock.t - t0).toBeLessThan(2_000);
  });

  test("continuous human input is never an indefinite lock: the deferral is bounded and answers with a reason", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    await observed(manager);

    const original = manager.wait;
    manager.wait = async (ms) => {
      await original(ms);
      manager.noteHumanInput("s", { force: true });
    };
    manager.noteHumanInput("s", { force: true });
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is interacting with tab 0");
    expect(clock.t - t0).toBeLessThanOrEqual(5_200);
  });

  test("a navigation is a new page: a mutation decided from the old one is refused — even after the agent's OWN navigate, it looks first", async () => {
    const { manager, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);

    views[0].webContents.emit("did-navigate");
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("the page navigated");

    const nav = await manager.callTool("s", "browser_navigate", { url: "https://example.org" });
    expect(nav.isError).toBeUndefined();
    const unseen = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(unseen.isError).toBe(true);
    expect(textOf(unseen)).toContain("the page navigated");
    await observed(manager);
    const ok = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(ok.isError).toBeUndefined();
  });

  test("human input DURING an in-flight action is detected between steps, not swallowed by the busy grace", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);

    const debug = views[0].webContents.debugger;
    let inserted = 0;
    const originalSend = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.insertText") {
        inserted += 1;

        if (inserted === 2) {
          clock.t += 500;
          expect(manager.noteHumanInput("s")).toBe(true);
        }
      }
      return result;
    };
    const result = await manager.callTool("s", "browser_type", { target: "e1", text: "hello", slowly: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Stopped");
    expect(inserted).toBeLessThan(5);
  });

  test("the agent's own click raises ONE preload report, which is consumed — a SECOND report during the same call is a human", async () => {
    const { manager, views, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    const attributed = [];
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
        clock.t += 1_200;
        attributed.push(manager.noteHumanInput("s"));

        attributed.push(manager.noteHumanInput("s"));
      }
      return result;
    };
    const result = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(attributed).toEqual([false, true]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Clicked");
    expect(textOf(result)).toContain("is interacting with tab 0");
  });

  test("an expected report that never arrives expires: it cannot swallow a human's click seconds later", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.callTool("s", "browser_click", { target: "e1" });
    clock.t += 2_500;
    expect(manager.noteHumanInput("s")).toBe(true);
  });

  test("force:true (the cockpit's chrome) during an in-flight action marks the interruption too", async () => {
    const { manager, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    let inserted = 0;
    debug.sendCommand = async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Input.insertText" && ++inserted === 2) manager.noteHumanInput("s", { force: true });
      return result;
    };
    const result = await manager.callTool("s", "browser_type", { target: "e1", text: "hello", slowly: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Stopped");
    expect(inserted).toBeLessThan(5);
  });

  test("typing in the address bar signals intent BEFORE submit: the next mutation defers", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.action("s", { action: "intent" });
    expect(manager.state("s").tabs[0].controller).toBe("human");
    const t0 = clock.t;
    const result = await manager.callTool("s", "browser_click", { target: "e1" });

    expect(result.isError).toBe(true);
    expect(clock.t - t0).toBeGreaterThanOrEqual(1_500);
  });

  test("a TIMED-OUT action cannot keep mutating once its successor starts: its next step stops on the cancelled context", async () => {
    const { manager, views } = harness({ rpcTimeoutMs: 50 });
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    const debug = views[0].webContents.debugger;
    const originalSend = debug.sendCommand.bind(debug);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const inserts = [];
    debug.sendCommand = async (method, params) => {
      if (method === "Input.insertText") {
        inserts.push(params.text);
        if (inserts.length === 1) await gate;
      }
      return originalSend(method, params);
    };
    const slow = manager.callTool("s", "browser_type", { target: "e1", text: "abc", slowly: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const timedOut = await slow;
    expect(textOf(timedOut)).toContain("timed out");

    await observed(manager);
    const next = manager.callTool("s", "browser_type", { target: "e1", text: "Z" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await next;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inserts).toEqual(["a", "Z"]);
  });

  test("a queued close acts on the tab it was queued for, by identity, not on whatever index means later", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });

    manager.noteHumanInput("s", { force: true });
    const pending = manager.callTool("s", "browser_tabs", { action: "close", index: 1 });

    manager.closeTab("s", 0);
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const urls = manager.state("s").tabs.map((tab) => tab.url);
    expect(urls).not.toContain("https://two.example/");
  });

  test("a pinned mutation whose tab is closed while it waits fails — it is never redirected to the active tab", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    await observed(manager);
    manager.noteHumanInput("s", { force: true });
    await observed(manager);
    const pending = manager.callTool("s", "browser_click", { target: "e1" });
    manager.closeTab("s", 0);
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/closed/);
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  test("a mutation is pinned to the tab it was queued for: a tab switch during its wait cannot redirect it", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await observed(manager);
    manager.noteHumanInput("s", { force: true });
    await observed(manager);

    const pending = manager.callTool("s", "browser_click", { target: "e1" });
    await manager.performAction("s", { action: "new", url: "https://two.example" }, "human");
    expect(manager.state("s").tabs[1].active).toBe(true);
    clock.t += 5_000;
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const clicks = (view) => view.webContents.debugger.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;
    expect(clicks(views[0])).toBeGreaterThan(0);
    expect(clicks(views[1])).toBe(0);
  });

  test("conflicting mutations on ONE tab run in order; another tab's mutation does not wait", async () => {
    const { manager, clock, views } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://one.example" });
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://two.example" });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    await observed(manager);
    manager.noteHumanInput("s", { force: true });
    await observed(manager);
    const order = [];
    const first = manager.callTool("s", "browser_click", { target: "e1" }).then(() => order.push("tab0-first"));
    const second = manager.callTool("s", "browser_click", { target: "e1" }).then(() => order.push("tab0-second"));

    await manager.callTool("s", "browser_snapshot", { tabId: 1 });
    await manager.callTool("s", "browser_tabs", { action: "select", index: 1 });
    const t0 = clock.t;
    const tab1 = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(tab1.isError).toBeUndefined();
    expect(clock.t - t0).toBeLessThan(1_500);
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);
    clock.t += 5_000;
    await Promise.all([first, second]);
    expect(order).toEqual(["tab0-first", "tab0-second"]);
  });

  test("the cockpit's URL bar is human by construction and needs no attribution window", async () => {
    const { manager } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    await observed(manager);
    await manager.action("s", { action: "navigate", url: "https://example.org" });
    expect(manager.state("s").tabs[0].controller).toBe("human");
    const stale = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(stale.isError).toBe(true);
  });

  test("state and list carry an ADVISORY activity that decays on its own — nothing to hand back", async () => {
    const { manager, clock } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    clock.t += 10_000;
    manager.noteHumanInput("s");
    expect(manager.state("s").tabs[0].controller).toBe("human");

    const listed = textOf(await manager.callTool("s", "browser_tabs", { action: "list" }));
    expect(listed).toMatch(/controller=human, opened-by=agent/);
    expect(listed).toMatch(/\byours\}/);
    expect(listed).toMatch(/\{tab=[^,}]+,/);
    expect(listed).toMatch(/profile=bp_[a-f0-9]{16}/);
    clock.t += 2_000;
    expect(manager.state("s").tabs[0].controller).toBe("idle");
    expect(typeof manager.handBack).toBe("undefined");
  });

  test("human input reported from a tab's own webContents marks THAT tab only", async () => {
    const { manager, views, clock } = harness();
    await manager.createTab("s", "localhost:3000");
    await manager.createTab("s", "https://example.com");
    clock.t += 10_000;
    manager.noteHumanInputFromWebContents(views[0].webContents);
    expect(manager.state("s").tabs[0].controller).toBe("human");
    expect(manager.state("s").tabs[1].controller).toBe("idle");
    manager.noteHumanInputFromWebContents({ unknown: true });
  });

  test("the tab cap refuses the 13th tab with a sentence", async () => {
    const { manager } = harness();
    for (let i = 0; i < 12; i += 1) await manager.createTab("s", "about:blank");
    const overCap = await manager.callTool("s", "browser_tabs", { action: "new" });
    expect(overCap.isError).toBe(true);
    expect(textOf(overCap)).toContain("Tab limit reached");
  });

  describe("the last tab closing ends the browser", () => {
    test("no blank tab is minted, the view is torn down, and the push says ended", async () => {
      const { manager, children, views, messages } = harness();
      await manager.createTab("t", "https://example.com", "human");
      const view = views[0];
      messages.length = 0;

      manager.closeTab("t", 0);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(manager.state("t").tabs).toEqual([]);

      expect(children.has(view)).toBe(false);
      expect(view.webContents.isDestroyed()).toBe(true);

      const pushes = messages.filter((message) => message.channel === "telar:browser:state");
      expect(pushes.at(-1).payload).toMatchObject({ scopeKey: "t", ended: true, tabs: [] });
    });

    test("`ended` is an EVENT, so a later read of the state does not repeat it", async () => {
      const { manager } = harness();
      await manager.createTab("t", "https://example.com", "human");
      manager.closeTab("t", 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("t").ended).toBeUndefined();
    });

    test("opening a browser again starts fresh — the profile binding outlives the browser", async () => {
      const { manager } = harness();
      await manager.createTab("t", "https://example.com", "human");
      manager.closeTab("t", 0);
      await new Promise((resolve) => setTimeout(resolve, 5));

      await manager.createTab("t", "https://again.example", "human");
      const tabs = manager.state("t").tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ url: "https://again.example/", active: true });
    });

    test("the tab strip's × and the tab menu's Close both end it", async () => {
      for (const index of [undefined, 0]) {
        const { manager } = harness();
        await manager.createTab("t", "https://example.com", "human");

        await manager.action("t", { action: "close", ...(index === undefined ? {} : { index }) });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(manager.state("t").tabs).toEqual([]);
      }
    });

    test("Close others then Close leaves nothing — the strip empties and stays empty", async () => {
      const { manager } = harness();
      await manager.createTab("t", "https://one.example", "human");
      await manager.createTab("t", "https://two.example", "human");

      await manager.action("t", { action: "close", index: 0 });
      expect(manager.state("t").tabs).toHaveLength(1);
      await manager.action("t", { action: "close", index: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("t").tabs).toEqual([]);
    });

    test("an AGENT closing its last tab ends it too, and is told its tab is gone", async () => {
      const { manager } = harness();
      await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
      await manager.callTool("s", "browser_tabs", { action: "close" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.state("s").tabs).toEqual([]);
      const orphaned = await manager.callTool("s", "browser_snapshot", {});
      expect(orphaned.isError).toBe(true);
      expect(textOf(orphaned)).toContain("was closed");

      expect((await manager.callTool("s", "browser_navigate", { url: "https://again.example" })).isError).toBeUndefined();
      expect(manager.state("s").tabs).toHaveLength(1);
    });
  });

  test("destroying a scope journals idle for its tabs", async () => {
    const { manager, changes } = harness();
    await manager.callTool("s", "browser_navigate", { url: "https://example.com" });
    manager.releaseScope("s", true);
    expect(changes.at(-1).controller).toBe("idle");
  });
});

describe("a sign-in never pauses a browser tool", () => {
  test("a tool call during a credential entry returns the tool's own result", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s1", "https://login.example");
    await manager.createTab("s2", "https://two.example");

    manager.addUiHold("p:popup", "1Password");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "fill" });
    for (const [scope, name, args] of [["s1", "browser_snapshot", {}], ["s2", "browser_snapshot", {}], ["s1", "browser_click", { target: "e1" }], ["s2", "browser_take_screenshot", {}], ["s1", "browser_console_messages", {}], ["s2", "browser_tabs", { action: "list" }]]) {
      const result = await manager.callTool(scope, name, args);
      expect(result.isError).toBeUndefined();
    }

    await manager.ensureDebugger(manager.activeTab("s1"));
    views[0].webContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "still logging" }] });
    expect(manager.activeTab("s1").console).toHaveLength(1);
  });

  test("the state the renderer reads carries no pause to draw", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://login.example");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "fill" });
    expect(manager.state("s").privacy).toBeUndefined();
  });

  test("a read or navigation whose tab lands on an extension page DURING the call is refused, not returned", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    const wc = views[0].webContents;

    const debug = wc.debugger;
    const original = debug.sendCommand.bind(debug);
    debug.sendCommand = async (method, params) => {
      if (method === "Accessibility.getFullAXTree") { wc.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/unlock.html"; }
      return original(method, params);
    };
    const snap = await manager.callTool("s", "browser_snapshot", {});
    expect(snap.isError).toBe(true);
    expect(textOf(snap)).toContain("now showing an extension page");

    wc.url = "https://example.com/";
    debug.sendCommand = original;
    await manager.callTool("s", "browser_snapshot", {});
    const realLoad = wc.loadURL.bind(wc);
    wc.loadURL = async (url) => { await realLoad(url); wc.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/redirected.html"; };
    const nav = await manager.callTool("s", "browser_navigate", { url: "https://sso.example/start" });
    expect(nav.isError).toBe(true);
    expect(textOf(nav)).toContain("now showing an extension page");
  });

  test("an extension page is never a target: not read, not acted on, not navigated to, and named but not exposed in the list", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "https://example.com");
    views[0].webContents.url = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html";
    views[0].webContents.emit("did-navigate");
    for (const [name, args] of [["browser_snapshot", {}], ["browser_take_screenshot", {}], ["browser_click", { target: "e1" }], ["browser_console_messages", {}]]) {
      const result = await manager.callTool("s", name, args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("extension page");
    }
    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(textOf(listed)).toContain("[Extension page](about:blank)");
    expect(textOf(listed)).not.toContain("chrome-extension://");
    const nav = await manager.callTool("s", "browser_navigate", { url: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/options.html" });
    expect(nav.isError).toBe(true);
    const opened = await manager.callTool("s", "browser_tabs", { action: "new", url: "chrome://extensions" });
    expect(opened.isError).toBe(true);
  });
});

describe("two pointers — the human's view and the agent's tab move independently", () => {
  function harness(options = {}) {
    const clock = { t: 1_000_000 };
    const base = makeHarness({ ...options, now: () => clock.t, wait: async (ms) => { clock.t += ms; } });
    return { ...base, clock };
  }
  const observed = async (manager, args = {}) => {
    const result = await manager.callTool("s", "browser_snapshot", args);
    expect(result.isError).toBeUndefined();
  };

  test("a tab the agent opens does not take the screen, and the human's stays put", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://issues.example/", "human");
    await manager.setVisible("s", true);

    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://docs.example/" });
    const tabs = manager.state("s").tabs;

    expect(tabs.map((tab) => [tab.url, tab.active, tab.agentFocus])).toEqual([
      ["https://issues.example/", true, false],
      ["https://docs.example/", false, true],
    ]);

    expect(manager.agentTab("s").url).toBe("https://docs.example/");
  });

  test("the human switching tabs does not re-aim the agent's next click", async () => {
    const { manager, views } = harness();
    await manager.createTab("s", "https://issues.example/", "human");
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://docs.example/" });
    await observed(manager);

    await manager.selectTab("s", 0);
    expect(manager.state("s").tabs[0].active).toBe(true);

    const clicked = await manager.callTool("s", "browser_click", { target: "e1" });
    expect(clicked.isError).toBeUndefined();
    const clicks = (view) => view.webContents.debugger.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;

    expect(clicks(views[1])).toBeGreaterThan(0);
    expect(clicks(views[0])).toBe(0);
  });

  test("the agent selecting a tab moves only itself", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await manager.selectTab("s", 1);

    await manager.callTool("s", "browser_tabs", { action: "select", index: 0 });
    expect(manager.state("s").tabs[1].active).toBe(true);
    expect(manager.agentTab("s").url).toBe("https://one.example/");
  });

  test("a write may name a tab, and naming one does not weaken the human's claim on it", async () => {
    const { manager, views, clock } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");
    await observed(manager, { tabId: 1 });

    const direct = await manager.callTool("s", "browser_click", { target: "e1", tabId: 1 });
    expect(direct.isError).toBeUndefined();
    expect(views[1].webContents.debugger.commands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);

    await observed(manager, { tabId: 0 });
    manager.noteHumanInput("s", { force: true, tab: manager.scopeTabs("s")[0] });
    const contested = await manager.callTool("s", "browser_click", { target: "e1", tabId: 0 });
    clock.t += 10_000;
    expect(contested.isError).toBe(true);
    expect(textOf(contested)).toMatch(/interacting with tab 0|changed since you last looked/);
  });

  test("a closed agent tab is reported once, not silently swapped for the human's", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://yours.example/", "human");
    await manager.callTool("s", "browser_tabs", { action: "new", url: "https://mine.example/" });
    await observed(manager);

    manager.closeTab("s", 1);

    const orphaned = await manager.callTool("s", "browser_snapshot", {});
    expect(orphaned.isError).toBe(true);
    expect(textOf(orphaned)).toMatch(/was closed\. List the tabs/);

    const listed = await manager.callTool("s", "browser_tabs", { action: "list" });
    expect(listed.isError).toBeUndefined();
    expect(manager.agentTab("s").url).toBe("https://yours.example/");
  });

  test("with no tab of its own the agent follows the human — 'look at this page' still works", async () => {
    const { manager } = harness();
    await manager.createTab("s", "https://one.example/", "human");
    await manager.createTab("s", "https://two.example/", "human");

    await manager.selectTab("s", 1);
    expect(manager.agentTab("s").url).toBe("https://two.example/");
    await manager.selectTab("s", 0);
    expect(manager.agentTab("s").url).toBe("https://one.example/");
  });
});

describe("the agent's pointer follows the tabs through a scope's life", () => {
  test("adoption carries the agent's tab; destroying a scope leaves no tombstone for the next one", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("draft", "none");
    await manager.createTab("draft", "https://one.example/", "human");
    await manager.callTool("draft", "browser_tabs", { action: "new", url: "https://two.example/" });
    expect(manager.agentTab("draft").url).toBe("https://two.example/");

    manager.adoptScope("draft", "real");

    expect(manager.agentTab("real").url).toBe("https://two.example/");
    expect(manager.agentTabIds.has("draft")).toBe(false);

    manager.releaseScope("real", true);
    expect(manager.agentTabIds.has("real")).toBe(false);
    expect(manager.agentTabClosed.has("real")).toBe(false);
  });
});

test("an extension host that re-selects a newly added tab cannot move the human's view", async () => {
  const { manager } = makeHarness();
  manager.declareProfile("s", "none");
  const host = {
    added: [],

    addTab(webContents) {
      this.added.push(webContents);
      const tab = manager.tabs.find((candidate) => candidate.view && candidate.view.webContents === webContents);
      if (tab) void manager.selectTab(tab.scopeKey, manager.scopeTabs(tab.scopeKey).indexOf(tab));
    },
    removeTab() {},
    selectTab() {},
    whenReady: async () => ({}),
  };
  manager.createExtensionHost = () => host;

  await manager.createTab("s", "https://yours.example/", "human");
  await manager.callTool("s", "browser_tabs", { action: "new", url: "https://mine.example/" });

  const tabs = manager.state("s").tabs;
  expect(host.added).toHaveLength(2);
  expect(tabs.map((tab) => [tab.url, tab.active, tab.agentFocus])).toEqual([
    ["https://yours.example/", true, false],
    ["https://mine.example/", false, true],
  ]);
});

test("only an interruption is reported as the human taking the browser", async () => {
  const clock = { t: 1_000_000 };
  const changes = [];
  const { manager } = makeHarness({ now: () => clock.t, onControlChanged: (change) => changes.push(change), wait: async (ms) => { clock.t += ms; } });
  await manager.createTab("s", "https://example.com/", "human");

  clock.t += 10_000;
  manager.noteHumanInput("s", { force: true });
  expect(changes.at(-1)).toMatchObject({ controller: "human" });
  expect(changes.at(-1).interrupted).toBeUndefined();

  const tab = manager.scopeTabs("s")[0];
  tab.agentBusy = 1;
  tab.lastJournaled = "agent";
  clock.t += 10_000;
  manager.noteHumanInput("s", { force: true });
  expect(changes.at(-1)).toMatchObject({ controller: "human", interrupted: true });
});
