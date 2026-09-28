import { afterEach, expect, test } from "bun:test";
import { BrowserToolSocket } from "../domains/browser";
import type { TurnDriver } from "../drivers";
import { eventually } from "../../test/wait";
import { setup, teardown } from "../../test/worker-daemon";

afterEach(teardown);

const fakeBrowserSocket = (beforeState: () => Promise<void> = async () => {}) =>
  new BrowserToolSocket({
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: () => false,
    tools: [{ name: "browser_navigate", description: "go", input: { shape: {} } }],
    state: async () => {
      await beforeState();
      return { provider: "headless", tabs: [{ id: "0", url: "http://x", title: "X", active: true }] };
    },
  });

test("a session keeps ONE browser lease across its turns, revoked when the worker stops", async () => {
  // The lease is baked into the provider's live process, which outlives the turn;
  // per-turn authority lives in the gate, re-pointed at each turn's claim.
  const leases: Array<{ url: string; token: string }> = [];
  const driver: TurnDriver = {
    async run({ browserSocket }) {
      leases.push(browserSocket!);
      return { text: "done" };
    },
  };
  const socket = fakeBrowserSocket();
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  try {
    await client.submitTurn(sessionId, { runId: "first", input: "One" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
    await client.submitTurn(sessionId, { runId: "second", input: "Two" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[1]?.state).toBe("completed"));

    // Two turns of the SAME session: same endpoint, SAME credential — the
    // live provider process holds this token for the session's whole life.
    expect(leases).toHaveLength(2);
    expect(leases[0]!.url).toBe(leases[1]!.url);
    expect(leases[0]!.token).toBe(leases[1]!.token);

    // Between turns the token still authenticates…
    const between = await fetch(leases[1]!.url, {
      method: "POST",
      headers: { authorization: `Bearer ${leases[1]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(between.status).toBe(200);

    // …and the worker's stop is the revocation.
    await worker.stop();
    const stale = await fetch(leases[1]!.url, {
      method: "POST",
      headers: { authorization: `Bearer ${leases[1]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(stale.status).toBe(401);
  } finally {
    await socket.close();
  }
});

test("a mutating socket call journals browser.state onto the turn that made it", async () => {
  // THE WHOLE LOOP, over real HTTP: driver → socket → gate (auto-accepted by
  // the session's default mode) → browser → onNavigated → reportObservations.
  const driver: TurnDriver = {
    async run({ browserSocket }) {
      const response = await fetch(browserSocket!.url, {
        method: "POST",
        headers: { authorization: `Bearer ${browserSocket!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_navigate", arguments: {} } }),
      });
      const answer = (await response.json()) as { result: { isError?: boolean } };
      if (answer.result.isError) throw new Error("the socket declined a call the mode should have accepted");
      // A successful tool reply now includes completion of its state journal,
      // so the provider may finish immediately without losing the panel state.
      expect((await client.events(sessionId)).events.some((event) => event.type === "browser.state.changed")).toBeTrue();
      return { text: "done" };
    },
  };
  // Delay the state read past the HTTP tool reply in the old fire-and-forget path.
  const socket = fakeBrowserSocket(() => Bun.sleep(30));
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  try {
    await client.submitTurn(sessionId, { runId: "run_one", input: "Browse" });
    await worker.tick();
    await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
    // The state report is asynchronous to the tool answer; it must still land
    // on THIS turn before it settles or arrive as this session's state.
    await eventually(async () => {
      const events = (await client.events(sessionId)).events;
      expect(events.some((event) => event.type === "browser.state.changed")).toBeTrue();
    });
  } finally {
    await socket.close();
  }
});

test("the claim carries the session's project id and the worker binds the browser profile BEFORE the turn's tools run", async () => {
  const bound: Array<[string, string]> = [];
  const socket = new BrowserToolSocket({
    call: async () => ({ content: [] }),
    isReadOnly: () => true,
    tools: [],
    bindProfile: async (scopeKey, profileKey) => { bound.push([scopeKey, profileKey]); },
  });
  const order: string[] = [];
  const driver: TurnDriver = { run: async () => { order.push(`run:${bound.length}`); return { text: "ok" }; } };
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  await client.submitTurn(sessionId, { runId: "run_bind", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed" }));
  expect(bound).toEqual([[sessionId, "project_one"]]);
  expect(order).toEqual(["run:1"]); // bound before the driver ran
});

test("a browser profile binding the host REFUSES does not fail the turn — the provider still runs", async () => {
  // The router re-issues the binding before each browser tool call, so a
  // refusal belongs to the call that needs it.
  const socket = new BrowserToolSocket({
    call: async () => ({ content: [] }),
    isReadOnly: () => true,
    tools: [],
    bindProfile: async () => { throw new Error("Not found."); },
  });
  let ran = 0;
  const driver: TurnDriver = { run: async () => { ran += 1; return { text: "ok" }; } };
  const { client, sessionId, worker } = await setup(driver, { browserSocket: socket });
  await client.submitTurn(sessionId, { runId: "run_bind_refused", input: "Hello" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]).toMatchObject({ state: "completed" }));
  expect(ran).toBe(1);
});
