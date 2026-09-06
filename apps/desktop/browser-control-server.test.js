const { describe, expect, test } = require("bun:test");
const net = require("node:net");
const { startBrowserControlServer } = require("./browser-control-server");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

describe("desktop browser control server", () => {
  test("authenticates and preserves the session scope", async () => {
    const calls = [];
    const control = await startBrowserControlServer({
      port: await freePort(),
      token: "secret",
      getBrowserManager: () => ({
        state(scopeKey) {
          return { scopeKey, provider: "desktop", tabs: [] };
        },
        callTool(scopeKey, name, args) {
          calls.push({ scopeKey, name, args });
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    });
    const origin = `http://127.0.0.1:${control.port}`;
    try {
      expect((await fetch(`${origin}/state?scopeKey=session-a`)).status).toBe(401);
      const state = await fetch(`${origin}/state?scopeKey=session-a`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(await state.json()).toMatchObject({ scopeKey: "session-a", provider: "desktop" });

      const tool = await fetch(`${origin}/tool`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ scopeKey: "session-a", name: "browser_tabs", args: { action: "list" } }),
      });
      expect(await tool.json()).toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(calls).toEqual([{
        scopeKey: "session-a",
        name: "browser_tabs",
        args: { action: "list" },
      }]);
    } finally {
      await control.close();
    }
  });
});

describe("control state over the wire", () => {
  test("/state relays per-tab controller and opener so the engine can route around a human", async () => {
    // A fake manager with the REAL state shape: what the engine's desktop
    // client parses is this wire contract, not the manager internals.
    const control = await startBrowserControlServer({
      port: 0,
      token: "secret",
      getBrowserManager: () => ({
        state(scopeKey) {
          return {
            scopeKey,
            provider: "desktop",
            controller: "human",
            tabs: [
              { index: 0, id: "t0", title: "Mine", url: "https://a.example", active: false, controller: "agent", openedBy: "agent" },
              { index: 1, id: "t1", title: "Yours", url: "https://b.example", active: true, controller: "human", openedBy: "human" },
            ],
          };
        },
      }),
    });
    try {
      const state = await fetch(`http://127.0.0.1:${control.port}/state?scopeKey=session-a`, {
        headers: { Authorization: "Bearer secret" },
      });
      const payload = await state.json();
      expect(payload.controller).toBe("human");
      expect(payload.tabs.map((tab) => tab.controller)).toEqual(["agent", "human"]);
      expect(payload.tabs.map((tab) => tab.openedBy)).toEqual(["agent", "human"]);
    } finally {
      await control.close();
    }
  });
});

describe("opening a tab for the human", () => {
  test("/open routes to manager.action so the tab is stamped human, never through callTool", async () => {
    const actions = [];
    const calls = [];
    const control = await startBrowserControlServer({
      port: 0,
      token: "secret",
      getBrowserManager: () => ({
        action(scopeKey, action) {
          actions.push({ scopeKey, action });
          return { scopeKey, running: true, tabs: [{ index: 0, title: "New tab", url: "about:blank", active: true, openedBy: "human" }] };
        },
        callTool(scopeKey, name, args) {
          calls.push({ scopeKey, name, args });
          return { content: [] };
        },
      }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${control.port}/open`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ scopeKey: "session-a" }),
      });
      const payload = await response.json();
      expect(payload.tabs[0].openedBy).toBe("human");
      expect(actions).toEqual([{ scopeKey: "session-a", action: { action: "new", url: "about:blank" } }]);
      expect(calls).toEqual([]);
    } finally {
      await control.close();
    }
  });

  test("/bind declares a scope's project profile on the manager and relays its refusal", async () => {
    const declared = [];
    const control = await startBrowserControlServer({
      port: 0,
      token: "secret",
      getBrowserManager: () => ({
        declareProfile(scopeKey, profileKey) {
          declared.push({ scopeKey, profileKey });
          if (profileKey === "bad") throw new Error("Browser profile key must be a project id");
          return { scopeKey, profileKey, partition: "persist:telar-project-x" };
        },
      }),
    });
    try {
      const post = (body) => fetch(`http://127.0.0.1:${control.port}/bind`, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const ok = await post({ scopeKey: "session-a", profileKey: "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).partition).toBe("persist:telar-project-x");
      const bad = await post({ scopeKey: "session-a", profileKey: "bad" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("project id");
      expect(declared).toHaveLength(2);
    } finally {
      await control.close();
    }
  });
});
