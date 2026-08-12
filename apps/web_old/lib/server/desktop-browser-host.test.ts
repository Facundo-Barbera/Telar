// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, jest, test } from "bun:test";
import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";
import { DesktopBrowserHostBroker } from "@/lib/server/desktop-browser-host";

const emptyDesktopState = (scopeKey = "scope-a"): ControlledBrowserState => ({
  scopeKey,
  available: true,
  running: true,
  provider: "desktop",
  tabs: [],
  screenshot: null,
  error: null,
  version: 1,
});

describe("desktop browser host broker", () => {
  test("gives each broker generation a stable unique identity", () => {
    const first = new DesktopBrowserHostBroker();
    const second = new DesktopBrowserHostBroker();
    expect(first.identity()).toBe(first.identity());
    expect(first.identity()).not.toBe(second.identity());
  });

  test("routes one agent command to the registered Electron host", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState());
    const unsubscribe = broker.subscribeCommands("desktop-a", (command) => {
      expect(command.name).toBe("browser_tabs");
      expect(command.scopeKey).toBe("scope-a");
      expect(command.args).toEqual({ action: "list" });
      broker.respond("desktop-a", command.id, {
        content: [{ type: "text", text: "- 0: (current) [Telar](http://localhost:3000/)" }],
      });
    });

    const result = await broker.call("scope-a", "browser_tabs", { action: "list" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "- 0: (current) [Telar](http://localhost:3000/)",
    });
    unsubscribe();
  });

  test("publishes desktop state and rejects pending work on disconnect", async () => {
    const broker = new DesktopBrowserHostBroker();
    const state = emptyDesktopState();
    state.tabs = [{ index: 0, id: "tab-a", title: "Telar", url: "http://localhost:3000/", active: true }];
    broker.register("desktop-a", state);
    expect(broker.state("scope-a")?.provider).toBe("desktop");
    expect(broker.state("scope-a")?.tabs[0]?.id).toBe("tab-a");
    expect(broker.state("scope-b")?.tabs).toEqual([]);

    const pending = broker.call("scope-a", "browser_snapshot", {});
    broker.disconnect("desktop-a");
    await expect(pending).rejects.toThrow("disconnected");
    expect(broker.state("scope-a")).toBeNull();
  });

  // Hosts coexist now, so this is a renderer reload: the replacement registers
  // and publishes before the outgoing one's keepalive-POST disconnect lands.
  test("replacing a host cannot be undone by the old renderer cleanup", () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState());
    broker.register("desktop-b", { ...emptyDesktopState(), version: 2 });
    broker.disconnect("desktop-a");
    expect(broker.online()).toBe(true);
    expect(broker.state("scope-a")?.version).toBe(2);
  });

  test("rejects legacy unscoped commands before they reach Electron", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState());
    let delivered = false;
    broker.subscribeCommands("desktop-a", () => { delivered = true; });

    await expect(broker.call("", "browser_tabs", { action: "list" }))
      .rejects.toThrow("browser session scope is required");
    expect(delivered).toBe(false);
  });

  test("routes each scope to the host holding that conversation's tabs", async () => {
    const broker = new DesktopBrowserHostBroker();
    const withTab = (scopeKey: string): ControlledBrowserState => ({
      ...emptyDesktopState(scopeKey),
      tabs: [{ index: 0, id: `tab-${scopeKey}`, title: "Telar", url: "http://localhost:3000/", active: true }],
    });
    broker.register("desktop-a", withTab("scope-a"));
    broker.register("desktop-b", withTab("scope-b"));
    const delivered: Array<{ host: string; scopeKey: string }> = [];
    for (const hostId of ["desktop-a", "desktop-b"]) {
      broker.subscribeCommands(hostId, (command) => {
        delivered.push({ host: hostId, scopeKey: command.scopeKey });
        broker.respond(hostId, command.id, { content: [{ type: "text", text: hostId }] });
      });
    }

    // scope-a is the OLDER registration: a background conversation must reach
    // its own surface, not whichever host happened to register last.
    const first = await broker.call("scope-a", "browser_snapshot", {});
    const second = await broker.call("scope-b", "browser_snapshot", {});
    expect(first.content[0]).toEqual({ type: "text", text: "desktop-a" });
    expect(second.content[0]).toEqual({ type: "text", text: "desktop-b" });
    expect(delivered).toEqual([
      { host: "desktop-a", scopeKey: "scope-a" },
      { host: "desktop-b", scopeKey: "scope-b" },
    ]);
  });

  test("a scope no host has claimed goes to the freshest live host", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    broker.subscribeCommands("desktop-a", (command) => {
      broker.respond("desktop-a", command.id, { content: [{ type: "text", text: "desktop-a" }] });
    });
    broker.subscribeCommands("desktop-b", (command) => {
      broker.respond("desktop-b", command.id, { content: [{ type: "text", text: "desktop-b" }] });
    });

    // Electron opens the view on demand, so an unclaimed scope is routable —
    // it just belongs to the most recently seen renderer.
    const result = await broker.call("scope-never-seen", "browser_tabs", { action: "list" });
    expect(result.content[0]).toEqual({ type: "text", text: "desktop-b" });
  });

  test("fails a scoped call immediately when no desktop surface is mounted", async () => {
    const broker = new DesktopBrowserHostBroker();
    const startedAt = Date.now();
    await expect(broker.call("scope-a", "browser_tabs", { action: "list" }))
      .rejects.toThrow("Open Telar Desktop and its Browser surface");
    // The bug this replaces held the call for the full 30s command timeout,
    // which reads as a wedged browser rather than a closed surface.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("keeps every other conversation's tabs when one host disconnects", async () => {
    const broker = new DesktopBrowserHostBroker();
    const stateA = emptyDesktopState("scope-a");
    stateA.tabs = [{ index: 0, id: "tab-a", title: "Telar", url: "http://localhost:3000/", active: true }];
    broker.register("desktop-a", stateA);
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    broker.subscribeCommands("desktop-b", (command) => {
      broker.respond("desktop-b", command.id, { content: [{ type: "text", text: "desktop-b" }] });
    });
    const pendingB = broker.call("scope-b", "browser_snapshot", {});

    broker.disconnect("desktop-a");
    // A disconnect fails only the work it was carrying, and the tabs of a scope
    // it published stay cached: they did not close because a renderer went away.
    await expect(pendingB).resolves.toBeDefined();
    expect(broker.online()).toBe(true);
    expect(broker.state("scope-a")?.tabs[0]?.id).toBe("tab-a");
  });

  test("fails only the disconnecting host's in-flight commands", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    broker.subscribeCommands("desktop-a", () => {});
    broker.subscribeCommands("desktop-b", () => {});
    const pendingA = broker.call("scope-a", "browser_snapshot", {});
    const pendingB = broker.call("scope-b", "browser_snapshot", {});

    broker.disconnect("desktop-a");
    await expect(pendingA).rejects.toThrow("disconnected");
    broker.respond("desktop-b", "unknown-command-id", { content: [{ type: "text", text: "ignored" }] });
    broker.disconnect("desktop-b");
    await expect(pendingB).rejects.toThrow("disconnected");
  });

  test("distinguishes a scope no host has published from a published empty one", () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    expect(broker.state("scope-a")?.running).toBe(true);
    const unknown = broker.state("scope-b");
    expect(unknown?.running).toBe(false);
    expect(unknown?.tabs).toEqual([]);
    // Never null while a host is live: null sends the caller to the Playwright
    // fallback, which must not spawn behind a working desktop browser.
    expect(unknown).not.toBeNull();
    expect(broker.state("scope-b")).not.toBeNull();
  });

  test("delivers commands queued before a host's command stream opens", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    const pending = broker.call("scope-a", "browser_tabs", { action: "list" });
    broker.subscribeCommands("desktop-a", (command) => {
      broker.respond("desktop-a", command.id, { content: [{ type: "text", text: "drained" }] });
    });
    const result = await pending;
    expect(result.content[0]).toEqual({ type: "text", text: "drained" });
  });

  test("dispatches to a reconnecting host's newest command stream", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    const stale: string[] = [];
    // The aborted stream stays registered until Next fires request.signal.abort
    // on the old response. Dispatching into it is the reported 30s hang: nobody
    // is reading it any more, so the command is never answered.
    broker.subscribeCommands("desktop-a", (command) => { stale.push(command.id); });
    broker.subscribeCommands("desktop-a", (command) => {
      broker.respond("desktop-a", command.id, { content: [{ type: "text", text: "fresh stream" }] });
    });

    const result = await broker.call("scope-a", "browser_tabs", { action: "list" });
    expect(result.content[0]).toEqual({ type: "text", text: "fresh stream" });
    expect(stale).toEqual([]);
  });

  test("re-dispatches a command past a stream that has already closed", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    // What an SSE send does once its controller is closed. The throw proves the
    // command never left the server, so replaying it cannot double-click a tab.
    broker.subscribeCommands("desktop-a", () => { throw new Error("Controller is already closed."); });
    const pending = broker.call("scope-a", "browser_snapshot", {});
    broker.subscribeCommands("desktop-a", (command) => {
      broker.respond("desktop-a", command.id, { content: [{ type: "text", text: "reconnected" }] });
    });

    expect((await pending).content[0]).toEqual({ type: "text", text: "reconnected" });
  });

  test("binds a fresh scope to the host that ran its first command", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    for (const hostId of ["desktop-a", "desktop-b"]) {
      broker.subscribeCommands(hostId, (command) => {
        broker.respond(hostId, command.id, { content: [{ type: "text", text: hostId }] });
      });
    }

    const first = await broker.call("scope-new", "browser_tabs", { action: "list" });
    // A keepalive tick makes desktop-a the freshest host. Without a claim taken
    // on dispatch the scope would follow it, opening a second Electron view for
    // one conversation — the state push that would have claimed it only lands
    // after the renderer's callTool resolves.
    broker.touch("desktop-a");
    const second = await broker.call("scope-new", "browser_snapshot", {});
    expect(first.content[0]).toEqual({ type: "text", text: "desktop-b" });
    expect(second.content[0]).toEqual({ type: "text", text: "desktop-b" });
  });

  test("holds a scope for its owner while the owner's stream reconnects", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    const strayed: string[] = [];
    const unsubscribeA = broker.subscribeCommands("desktop-a", () => {});
    broker.subscribeCommands("desktop-b", (command) => {
      strayed.push(command.scopeKey);
      broker.respond("desktop-b", command.id, { content: [{ type: "text", text: "desktop-b" }] });
    });
    unsubscribeA();

    // desktop-a is mid-EventSource-reconnect: registered, no open stream. Its
    // queue drains when the stream returns, whereas acting on another window's
    // tabs opens a duplicate view that nothing closes.
    const pending = broker.call("scope-a", "browser_snapshot", {});
    await Promise.resolve();
    expect(strayed).toEqual([]);
    broker.subscribeCommands("desktop-a", (command) => {
      broker.respond("desktop-a", command.id, { content: [{ type: "text", text: "desktop-a" }] });
    });
    expect((await pending).content[0]).toEqual({ type: "text", text: "desktop-a" });
  });

  test("forgets cached tabs once the last host disconnects", () => {
    const broker = new DesktopBrowserHostBroker();
    const state = emptyDesktopState("scope-a");
    state.tabs = [{ index: 0, id: "tab-a", title: "Telar", url: "http://localhost:3000/", active: true }];
    state.screenshot = "data:image/png;base64,AAAA";
    broker.register("desktop-a", state);

    // The desktop app quit and relaunched: a new process, so the old tabs are
    // gone. Serving them would show tabs that cannot be clicked, indefinitely.
    broker.disconnect("desktop-a");
    broker.register("desktop-b", emptyDesktopState("__host__"));
    expect(broker.state("scope-a")?.tabs).toEqual([]);
    expect(broker.state("scope-a")?.running).toBe(false);
    expect(broker.state("scope-a")?.screenshot).toBeNull();
  });

  test("evicts cold scopes without blanking one a live host still holds", () => {
    const broker = new DesktopBrowserHostBroker();
    const held = emptyDesktopState("scope-live");
    held.tabs = [{ index: 0, id: "tab-live", title: "Telar", url: "http://localhost:3000/", active: true }];
    broker.register("desktop-a", held);
    broker.register("desktop-b", emptyDesktopState("scope-cold"));
    for (let index = 0; index < 40; index += 1) {
      broker.updateState("desktop-b", emptyDesktopState(`scope-bg-${index}`));
    }

    // The ceiling must not blank the conversation the user is looking at while
    // its host reports itself online — that is the symptom, not the fix.
    expect(broker.state("scope-live")?.running).toBe(true);
    expect(broker.state("scope-live")?.tabs[0]?.id).toBe("tab-live");
    expect(broker.state("scope-cold")?.running).toBe(false);
  });

  test("keeps the registration placeholder out of the scope cache", () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("__host__"));
    expect(broker.online()).toBe(true);
    // No conversation owns it, so it must not claim a cache slot or report tabs.
    expect(broker.state("__host__")?.running).toBe(false);
  });

  test("fails a command no command stream ever accepted before the tool timeout", async () => {
    jest.useFakeTimers();
    try {
      const broker = new DesktopBrowserHostBroker();
      broker.register("desktop-a", emptyDesktopState("scope-a"));
      const pending = broker.call("scope-a", "browser_snapshot", {});
      // `expect().rejects` deadlocks against bun's fake timers, so catch by hand.
      const failure = pending.then(() => null, (error: Error) => error);
      // Well inside the 30s tool timeout, which reads as a wedged browser.
      jest.advanceTimersByTime(11_000);
      expect((await failure)?.message).toContain("command stream is closed");
    } finally {
      jest.useRealTimers();
    }
  });

  test("ignores a response from a host the command was not dispatched to", async () => {
    const broker = new DesktopBrowserHostBroker();
    broker.register("desktop-a", emptyDesktopState("scope-a"));
    broker.register("desktop-b", emptyDesktopState("scope-b"));
    let hijacked: string | null = null;
    broker.subscribeCommands("desktop-a", (command) => { hijacked = command.id; });
    broker.subscribeCommands("desktop-b", () => {});
    const pending = broker.call("scope-a", "browser_snapshot", {});
    await Promise.resolve();
    if (!hijacked) throw new Error("the scoped command never reached its host");

    broker.respond("desktop-b", hijacked, { content: [{ type: "text", text: "wrong host" }] });
    broker.disconnect("desktop-a");
    await expect(pending).rejects.toThrow("disconnected");
  });
});
