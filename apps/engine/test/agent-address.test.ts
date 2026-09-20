/**
 * A SESSION CAN ADDRESS THE AGENT — issue #784, step 1.
 *
 * `agent/inbox.ts` has declared this seam and its own absence since #541:
 * *"`peer_message` IS THE FIFTH, and it has no producer yet … the day something
 * CAN address the Agent, the row it writes should not need a migration to
 * exist."* These tests are that day, and they are mostly about what must NOT
 * happen: no turn anywhere, no session invented by the reserved name, and no
 * door quietly 404-ing an address the tool description just offered.
 *
 * ── THE ORDER THESE WERE WRITTEN IN, AND WHY ────────────────────────────────
 * The blocker test is FIRST, on purpose. The investigation on #784 named one
 * way this change could make things worse: reports move to the inbox, nobody
 * checks the blocker path, and the single message that should interrupt becomes
 * the one that waits for somebody to open the app. So the first thing asserted
 * is the thing that must not move — and it is asserted by TURN COUNT on the
 * recipient, under every cadence, rather than by reading a delivery field that
 * could be right while the queue was wrong.
 *
 * ── AND ONE PREMISE THE BRIEF CARRIED IS FALSE ──────────────────────────────
 * The dispatch asked for a guard that an orchestrator's `blocker` "still lights
 * the Needs-you band". It does not light it today and this change does not make
 * it: `activity: "blocked"` comes from an OPEN ENGINE REQUEST and nothing else
 * (`EngineStore.withActivity` → `liveRequests`), so a peer's `blocker` message
 * reads as `queued` exactly like any other work arriving. The investigation
 * comment says the same thing. What is true and load-bearing is that a blocker
 * is never HELD, and that is what the first test holds. The band is asserted
 * too — as `queued` rather than `blocked` — so that a later change cannot
 * quietly alter it in either direction without a red line here.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { EngineClient, HOLD_REPORTS } from "@telar/engine-client";
import type { AgentInboxRow } from "../src/agent/inbox";
import { AGENT_SELF_ID } from "../src/agent/identity";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineStateError, EngineStore } from "../src/state";
import { stubModels } from "./stub-models";

const homes: string[] = [];
const stores: EngineStore[] = [];
const daemons: EngineDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close().catch(() => undefined);
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const START = 1_700_000_000_000;

/**
 * A HOST, A WORKER, AND A LIVE CLAIM ON THE WORKER — the same fixture
 * `report-window.test.ts` uses, because these are the same two sessions and the
 * claim is what `Turn.sender` is stamped from.
 *
 * `rows` STANDS IN FOR THE AGENT'S RUNTIME at this level: the store's whole
 * contract with it is the sink, and a fake one lets the refusals and the row's
 * CONTENT be asserted without a LangGraph thread. The end-to-end test below
 * uses a real one, for the one claim a fake sink cannot make — that no turn
 * started.
 */
function setup(options: { sink?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-address-"));
  homes.push(home);
  const clock = { now: START };
  const store = new EngineStore(home, () => clock.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  const rows: AgentInboxRow[] = [];
  if (options.sink !== false) {
    store.setAgentWakeSink((wake) => {
      const row: AgentInboxRow = {
        id: rows.length + 1,
        at: clock.now,
        sessionId: wake.notification.sessionId ?? "",
        runId: wake.notification.runId ?? "",
        kind: wake.inboxKind ?? "peer_message",
        ...(wake.notification.intent ? { intent: wake.notification.intent } : {}),
        summary: wake.notification.summary,
        read: false,
      };
      rows.push(row);
      return row;
    });
  }
  return { store, clock, rows, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * 1. THE THING THAT MUST NOT MOVE.
 * ══════════════════════════════════════════════════════════════════════════ */

test("a blocker is never held, under EVERY cadence, and a session with none behaves exactly as today", () => {
  /**
   * THREE CADENCES IN ONE LOOP, counted rather than described. `run_report`
   * lands first each time so there is something holdable in the box — a blocker
   * that arrived into an empty session would pass this test under a hold that
   * swallowed everything.
   */
  for (const cadence of [undefined, 25, HOLD_REPORTS] as const) {
    const { store, proof } = setup();
    if (cadence !== undefined) store.updateSession("session_host", { reportWindowMinutes: cadence });
    const before = store.turns("session_host").filter((turn) => turn.state === "queued").length;
    expect(before).toBe(0);

    store.submitAgentTurn("session_host", { runId: "run_report", input: "progress", intent: "report" }, proof);
    // WITH a cadence the report is held; WITHOUT one it is delivered on arrival,
    // which is #631 part 2 and is the positive control for the whole file.
    const afterReport = store.turns("session_host").filter((turn) => turn.state === "queued").length;
    expect(afterReport).toBe(cadence === undefined ? 1 : 0);

    store.submitAgentTurn("session_host", { runId: "run_blocker", input: "The build host is out of disk.", intent: "blocker" }, proof);
    // THE COUNT, NOT THE FIELD. One more queued turn than before the blocker,
    // whatever the cadence — a delivery decision that read "wake" while the
    // queue stayed empty would pass an assertion on `agentDelivery` and fail
    // the person.
    const afterBlocker = store.turns("session_host").filter((turn) => turn.state === "queued");
    expect(afterBlocker).toHaveLength(afterReport + 1);
    expect(afterBlocker.some((turn) => turn.runId === "run_blocker")).toBe(true);
    // And it is CLAIMABLE — a queued turn nothing will pick up is not a
    // delivery. Under a hold this is the only thing that reaches the session.
    expect(store.claimTurn("session_host", "worker_two")).toBeDefined();
  }
});

test("a peer's blocker does NOT light the Needs-you band, and an open request still does", () => {
  /**
   * THE PREMISE THE DISPATCH CARRIED, CHECKED RATHER THAN BUILT ON. `blocked`
   * is an OPEN REQUEST and nothing else; a peer's `blocker` is work arriving and
   * reads as `queued`. Both directions are asserted so a change to either is a
   * red line rather than a silent shift — this is the band a person actually
   * scans, and it must not start or stop lighting by accident.
   */
  const { store, proof } = setup();
  store.submitAgentTurn("session_host", { runId: "run_blocker", input: "out of disk", intent: "blocker" }, proof);
  expect(store.getSession("session_host").activity).toBe("queued");

  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_blocker", token);
  // A question, which no runtime mode auto-answers — so it genuinely parks.
  store.openRequest("session_host", "run_blocker", token, {
    requestId: "req_one",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Which base?", fields: [{ key: "base", label: "Base", kind: "text", required: true }] },
  });
  expect(store.getSession("session_host").activity).toBe("blocked");
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 2. THE REFUSALS — written before the happy path, as the investigation asked.
 * ══════════════════════════════════════════════════════════════════════════ */

test("every caller that validates a session id refuses the reserved Agent id in words", () => {
  const { store } = setup();
  /**
   * ONE CALL PER VERB THE WALL EXPOSES, because "`requireSession` refuses it"
   * is a claim about a private method and these are the doors a model actually
   * knocks on. A new verb that reached the store another way would land here as
   * a missing line rather than as a surprise in production.
   */
  const calls: Array<[string, () => unknown]> = [
    ["getSession", () => store.getSession(AGENT_SELF_ID)],
    ["readEvents", () => store.readEvents(AGENT_SELF_ID, 0)],
    ["turns", () => store.turns(AGENT_SELF_ID)],
    ["requests", () => store.requests(AGENT_SELF_ID)],
    ["stopSession", () => store.stopSession(AGENT_SELF_ID, "agent")],
    ["updateSession", () => store.updateSession(AGENT_SELF_ID, { settledOverride: "settled" })],
    ["subscribe (as target)", () => store.subscribe("session_host", { targetSessionId: AGENT_SELF_ID })],
    ["submitTurn", () => store.submitTurn(AGENT_SELF_ID, { runId: "run_x", input: "hello" })],
    ["submitAgentTurn", () => store.submitAgentTurn(AGENT_SELF_ID, { runId: "run_x", input: "hello" })],
  ];
  for (const [label, call] of calls) {
    let thrown: unknown;
    try {
      call();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, label).toBeInstanceOf(EngineStateError);
    /**
     * `invalid_request`, NOT `not_found`, AND THIS IS THE ASSERTION THAT
     * MATTERS. "session does not exist" for the one id that deliberately does
     * not tells a model to try again with a different one; the whole point of
     * reserving a name is that the refusal explains what the name IS.
     */
    expect((thrown as EngineStateError).code, label).toBe("invalid_request");
    expect((thrown as EngineStateError).message, label).toContain("not a session");
  }
  // AND AN ORDINARY MISSING SESSION IS STILL A MISSING SESSION. Without this,
  // a refusal broad enough to swallow `not_found` would pass every line above.
  expect(() => store.getSession("session_nope")).toThrow(
    expect.objectContaining({ code: "not_found" }) as unknown as Error,
  );
});

test("only a session inside a live turn may address the Agent", () => {
  const { store, proof } = setup();
  // THE OUTWARD SOCKET: a chat client, not a session. It has no run for the
  // row's fetch call to name, and the person using it has the Agent in front of
  // them already.
  expect(() => store.sendToAgent({ input: "hello" })).toThrow(EngineStateError);
  // THE AGENT ITSELF, whose proof is claimless: a conversation that could write
  // its own inbox would open its next turn reading a digest of what it said.
  expect(() => store.sendToAgent({ input: "hello" }, { sessionId: AGENT_SELF_ID })).toThrow(/cannot address itself/);
  // A CLAIM THAT IS NOT LIVE, refused by the same check every other send uses.
  expect(() => store.sendToAgent({ input: "hello" }, { ...proof, claimToken: "not-the-token" })).toThrow(EngineStateError);
  // And the live claim goes through — the positive control for the three above.
  expect(store.sendToAgent({ input: "hello" }, proof).row).toBeDefined();
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 3. THE HAPPY PATH.
 * ══════════════════════════════════════════════════════════════════════════ */

test("one send is exactly one row, about the SENDER, with a fetch call that works", () => {
  const { store, rows, proof } = setup();
  const { row, notice } = store.sendToAgent({ input: "The premise moved: the clock already exists.", intent: "report" }, proof);

  expect(rows).toHaveLength(1);
  expect(row).toEqual(rows[0]!);
  expect(row).toMatchObject({ kind: "peer_message", intent: "report", sessionId: "session_worker", runId: "run_source" });

  /**
   * THE ROW IS ABOUT THE SENDER, AND THAT IS WHAT MAKES THE BODY RETRIEVABLE.
   * Nothing stores a body for the Agent, so the only copy of what was said is
   * in the sending turn — which is exactly the pair this row carries. A row
   * naming the Agent as its own subject would point the digest at the
   * conversation the person is already in.
   */
  expect(notice).toContain(`sessions_read(sessionId: "session_worker", runId: "run_source")`);
  expect(store.turns("session_worker").some((turn) => turn.runId === "run_source")).toBe(true);
  // NO PART OF THE MESSAGE IS IN THE NOTICE (#631), here as everywhere else.
  expect(notice).not.toContain("The premise moved");
  expect(notice).toContain("44 chars");
});

test("a send with the Agent switched off says NOT DELIVERED rather than 'sent'", () => {
  // No sink registered: the Agent is off on this machine, or has no thread yet.
  const { store, proof } = setup({ sink: false });
  const answer = store.sendToAgent({ input: "anybody there?" }, proof);
  expect(answer.row).toBeUndefined();
  // The notice is still minted — it is what the sender is shown — but nothing
  // kept the message, and the ABSENT row is how the caller knows.
  expect(answer.notice).toContain("[agent message · report]");
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 4. AND NO TURN — the assertion the whole issue turns on.
 * ══════════════════════════════════════════════════════════════════════════ */

/** A model that answers once. If the Agent ever starts a turn, this is what
 *  would run — so a test that counts thread rows would see it. */
class ScriptedChatModel extends BaseChatModel {
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: "done." });
    return { generations: [{ text: "done.", message }] };
  }
}

test("a sessions_send to the Agent writes one inbox row and starts NO turn in the thread", async () => {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-address-e2e-"));
  homes.push(engineRoot);
  fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const daemon = await startEngine({ models: stubModels, engineRoot, agentModel: () => new ScriptedChatModel({}) });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.setAgent({ enabled: true });

  daemon.store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  daemon.store.createSession({ id: "session_worker", projectId: "project_one" });
  daemon.store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = daemon.store.claimTurn("session_worker", "worker_one")!.claim!.token;
  daemon.store.markRunning("session_worker", "run_source", claimToken);

  /**
   * THE THREAD'S TURN COUNT BEFORE AND AFTER, which is the direction that fails
   * when this regresses. A test that only asserted the row exists would pass
   * with the turn firing too — and the turn is the entire cost this issue is
   * about: a model call, a lap of the graph, a row in a conversation the person
   * was reading.
   */
  const turnsIn = async (): Promise<number> =>
    (await client.agentThread({ limit: 200 })).rows.filter((row) => row.kind === "turn_started" || row.kind === "turn_done").length;
  const before = await turnsIn();
  expect((await client.agentInbox({ unreadOnly: true })).unread).toBe(0);

  const sent = await client.sendToAgent({
    input: "Twenty-five minutes of orchestration, nothing blocked.",
    intent: "report",
    proof: { sessionId: "session_worker", runId: "run_source", claimToken },
  });

  expect(sent.row).toMatchObject({ kind: "peer_message", intent: "report", sessionId: "session_worker" });
  /**
   * THE TURN COUNT FIRST, because it is the assertion that fails when this
   * regresses and the row's is not. A digest turn would consume the row on its
   * way past, so "one unread row" can go wrong in either direction while the
   * thread is the thing that says whether anybody was interrupted.
   */
  expect(await turnsIn()).toBe(before);
  expect((await client.agent()).agent).toMatchObject({ running: false, queued: 0 });
  const inbox = await client.agentInbox({ unreadOnly: true });
  expect(inbox.unread).toBe(1);
  expect(inbox.rows).toHaveLength(1);
});

test("the HTTP door refuses an unproven caller rather than recording an anonymous row", async () => {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-address-http-"));
  homes.push(engineRoot);
  fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const daemon = await startEngine({ models: stubModels, engineRoot, agentModel: () => new ScriptedChatModel({}) });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.setAgent({ enabled: true });

  const response = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/agent/inbox/message`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "who am I?" }),
  });
  expect(response.status).toBe(400);
  // Nothing was written: a row with no sender has no fetch call, which is the
  // whole of what it carries.
  expect((await client.agentInbox({ unreadOnly: true })).unread).toBe(0);
});
