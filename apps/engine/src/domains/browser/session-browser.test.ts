import { expect, test } from "bun:test";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("a store with no browser attached reports none rather than failing", async () => {
  const { store } = readyStore();
  // The ordinary answer for a session that has never browsed, and the same one
  // a deployment whose worker owns the browser gives. One code path, not two.
  // `canStart: false` is what tells a client not to offer an "open a browser"
  // button that would start one beside the worker's own.
  expect(await store.browserState("session_one")).toEqual({
    scopeKey: "session_one",
    provider: "none",
    running: false,
    tabs: [],
    canStart: false,
  });
});

test("a hand-started browser journals its tabs exactly once, so the panel can show them", async () => {
  const { store } = readyStore();
  const tabs = [{ id: "0", url: "http://x", title: "X", active: true }];
  store.attachBrowser({
    state: async () => ({ provider: "headless" as const, running: true, tabs }),
    release: async () => undefined,
  } as never);

  // A plain read journals nothing: asking what the browser shows must never
  // become history. Only the explicit `start` gesture is an event.
  await store.browserState("session_one");
  const before = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(before).toHaveLength(0);

  const started = await store.browserState("session_one", { start: true });
  expect(started.canStart).toBe(true);
  // A second press with the same tab set journals nothing new.
  await store.browserState("session_one", { start: true });
  const events = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(events).toHaveLength(1);
  expect((events[0] as { tabs: { url: string }[] }).tabs[0]?.url).toBe("http://x");
});

test("a hand-started browser binds the session's project profile BEFORE opening, even with no worker turn and no mounted surface", async () => {
  const { store } = readyStore(); // creates session_one in project_one
  const calls: Array<{ op: string; scopeKey: string; profileKey?: string; start?: boolean }> = [];
  store.attachBrowser({
    bindProfile: async (scopeKey: string, profileKey: string) => { calls.push({ op: "bind", scopeKey, profileKey }); },
    state: async (scopeKey: string, options: { start?: boolean }) => { calls.push({ op: "state", scopeKey, start: options.start }); return { provider: "attached" as const, running: true, tabs: [] }; },
    release: async () => undefined,
  } as never);
  await store.browserState("session_one", { start: true });
  // Bind happened, with the session's project, BEFORE the state read that opens.
  expect(calls).toEqual([
    { op: "bind", scopeKey: "session_one", profileKey: "project_one" },
    { op: "state", scopeKey: "session_one", start: true },
  ]);
  // A plain read (no start) does not bind — nothing opens, so nothing to bind.
  calls.length = 0;
  await store.browserState("session_one");
  expect(calls.find((c) => c.op === "bind")).toBeUndefined();
});

test("browserOpen opens an http(s) page as the human on the session's browser and journals the tab set", async () => {
  const { store } = readyStore();
  const calls: Array<{ op: string; name?: string; args?: Record<string, unknown>; profileKey?: string }> = [];
  let tabs: { id: string; url: string; title: string; active: boolean }[] = [];
  store.attachBrowser({
    bindProfile: async (_scopeKey: string, profileKey: string) => { calls.push({ op: "bind", profileKey }); },
    call: async (_scopeKey: string, name: string, args: Record<string, unknown>) => {
      calls.push({ op: "call", name, args });
      tabs = [{ id: "0", url: String(args.url), title: "Docs", active: true }];
      return { content: [{ type: "text", text: "opened" }] };
    },
    state: async () => ({ provider: "attached" as const, running: true, tabs }),
    release: async () => undefined,
  } as never);
  const answer = await store.browserOpen("session_one", "https://example.test/docs");
  expect(answer.tabs.map((tab) => tab.url)).toEqual(["https://example.test/docs"]);
  expect(calls).toEqual([
    { op: "bind", profileKey: "project_one" },
    { op: "call", name: "browser_tabs", args: { action: "new", url: "https://example.test/docs" } },
    // browserState({start}) binds again before its read — idempotent, and the
    // one write that journals the tab set for the panel.
    { op: "bind", profileKey: "project_one" },
  ]);
  const events = store.readEvents("session_one").filter((event) => event.type === "browser.state.changed");
  expect(events).toHaveLength(1);
  await expect(store.browserOpen("session_one", "file:///etc/passwd")).rejects.toThrow(/only http and https/);
  await expect(store.browserOpen("session_one", "not a url")).rejects.toThrow(/not a URL/);
});

test("recordBrowserControl journals transitions once each and refuses unknown sessions", () => {
  const { store } = readyStore();
  store.recordBrowserControl("session_one", "agent");
  store.recordBrowserControl("session_one", "human");
  store.recordBrowserControl("session_one", "human"); // the shell re-reporting
  store.recordBrowserControl("session_one", "agent");
  const rows = store
    .readEvents("session_one")
    .filter((event) => event.type === "browser.control.changed")
    .map((event) => (event as { controller: string }).controller);
  expect(rows).toEqual(["agent", "human", "agent"]);
  expect(() => store.recordBrowserControl("session_missing", "human")).toThrow();
});
