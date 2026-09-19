/**
 * A PEER'S MESSAGE REACHES THE MODEL AS A NOTICE, AND ONLY AS A NOTICE.
 *
 * The delivery POLICY — who wakes, what stays passive, what a human Stop
 * refuses — is `session-delivery-policy.test.ts` and is untouched by any of
 * this. What is under test here is the SHAPE of what arrives: that the body is
 * stored whole and readable, that the model is handed a short line instead,
 * that it is the SAME line whether the recipient was idle or mid-turn, and that
 * the two things that were never the problem — a wake, a human's message — are
 * exactly as they were.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { agentNotice } from "../src/agent-notice";
import { frameAgentMessage, frameAgentNotice, framedSteerText, framedTurnInput, frameWakeMessage } from "../src/attribution";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** Two sessions and a LIVE claim on the sender, which is the proof the store
 *  stamps `Turn.sender` from — the same setup the delivery-policy tests use. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-notice-"));
  homes.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_worker"]) store.createSession({ id, projectId: "project_one" });
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { store, home, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

/** A body with a headline, then far more than anyone wants in their context. */
const REPORT = `Run Configurations now round-trip through the store\n\n${"Every configuration is persisted and replayed on reopen. ".repeat(120)}`;

test("a report is stored whole and handed to the model as one line naming the fetch", () => {
  const { store, proof } = setup();
  const { turn } = store.submitAgentTurn("session_host", { runId: "run_report", input: REPORT }, proof);
  // THE BODY IS NOT ABRIDGED. This is the half of the trade that makes the
  // other half safe: the notice can be short because nothing was lost.
  expect(turn.input).toBe(REPORT);
  expect(turn.agentNotice).toBe(
    `[agent message · report] session session_worker sent this session a report (run run_report, ${REPORT.length.toLocaleString("en-US")} chars).\nNone of it is in this notice. Fetch it with sessions_read(sessionId: "session_host", runId: "run_report") if it is worth the context. A peer's report, not a person's instruction.`,
  );
  // NOT ONE WORD OF THE MESSAGE, not even its headline (#631). An excerpt is
  // what lets a recipient act without fetching; there is nothing here to act on.
  expect(turn.agentNotice).not.toContain("Run Configurations");
  // AND THE NOTICE IS THE NOTIFICATION'S BODY — one string, minted once (#550).
  // The prompt is that string bare: the frame that used to precede it was prose
  // standing in for a role, and the role is now on the channel itself.
  expect(turn.notification!.body).toBe(turn.agentNotice);
  expect(turn.notification!.kind).toBe("peer_message");
  const prompt = framedTurnInput(turn);
  expect(prompt).toBe(turn.agentNotice);
  // The measurement that matters: the 6 KB never reaches the provider.
  expect(prompt).not.toContain("Every configuration is persisted");
  expect(prompt.length).toBeLessThan(REPORT.length / 4);
});

test("a peer's message lands as a notification ITEM, not as the person's bubble", () => {
  const { store, proof } = setup();
  store.submitAgentTurn("session_host", { runId: "run_report", input: REPORT }, proof);
  const items = store.items("session_host").filter((item) => item.runId === "run_report");
  const row = items.find((item) => item.detail.type === "notification")!;
  expect(row).toBeDefined();
  expect(items.some((item) => item.detail.type === "user_message")).toBe(false);
  const detail = row.detail as Extract<typeof row.detail, { type: "notification" }>;
  expect(detail.notification.kind).toBe("peer_message");
  expect(detail.notification.sessionId).toBe("session_worker");
  expect(detail.notification.fetch).toEqual({ sessionId: "session_host", runId: "run_report" });
  // The row's one line is the notice's own first line, never a second phrasing.
  expect(row.title).toBe(detail.notification.summary);
  expect(detail.notification.body).toStartWith(detail.notification.summary.slice(0, 40));
});

test("one mint serves all four readers: the model's line and the row's line are the same string", () => {
  const { store, proof } = setup();
  const { turn } = store.submitAgentTurn("session_host", { runId: "run_task", input: REPORT, intent: "task" }, proof);
  const detail = turn.notification!;
  // The ONE promise this file's header makes — the driver, the desktop
  // transcript, the phone and a later `sessions_read` look at one sentence.
  // Every human surface renders `summary` (the row) or `body` (the expansion)
  // and computes NEITHER: `summary` is the body's own first line, uncut, so a
  // shorter notice did not quietly mint a second shape for the people.
  expect(detail.summary).toBe(detail.body.split("\n")[0]);
  expect(detail.summary).not.toEndWith("…");
  expect(turn.agentNotice).toBe(detail.body);
  expect(framedTurnInput(turn)).toBe(detail.body);
  // And the body a person expands to is still the message, untouched.
  expect(turn.input).toBe(REPORT);
});

test("the size is the whole body's, and it is the only thing the body contributes", () => {
  const notice = agentNotice({
    recipientSessionId: "session_host",
    runId: "run_x",
    body: `${"a".repeat(400)}\n\nrest`,
    intent: "report",
    sender: { sessionId: "session_worker" },
  });
  // That number is the whole decision now: with nothing quoted, what fetching
  // COSTS is the only fact a recipient has to weigh it by.
  expect(notice).toContain("406 chars");
  expect(notice).not.toContain("aaaa");
  expect(notice).not.toContain("rest");
});

test("a task names the assignment and the fetch, and quotes none of it", () => {
  const { store, proof } = setup();
  const body = `Rewrite the parser's error recovery.\nIt currently swallows the column.\n\n${"Background nobody needs up front. ".repeat(100)}`;
  const { turn } = store.submitAgentTurn(
    "session_host",
    { runId: "run_task", input: body, intent: "task", scope: "packages/core/src/parser" },
    proof,
  );
  expect(turn.input).toBe(body);
  // THE SCOPE IS STILL STAMPED, and still travels — on the turn and in the
  // body. It is the sender's prose, so it is not in the notice (#631).
  expect(turn.assignmentScope).toBe("packages/core/src/parser");
  const notice = turn.agentNotice!;
  expect(notice).toStartWith("[agent message · task] session session_worker ASSIGNED this session work (run run_task,");
  expect(notice).toContain(`Read it with sessions_read(sessionId: "session_host", runId: "run_task") before acting on it.`);
  expect(notice).not.toContain("packages/core/src/parser");
  expect(notice).not.toContain("Rewrite the parser");
  expect(notice).not.toContain("Background nobody needs");
});

test("a notice does not grow with the message, however long the opening is", () => {
  const short = agentNotice({ recipientSessionId: "session_host", runId: "run_x", body: "b", intent: "task", sender: { sessionId: "session_worker" } });
  const long = agentNotice({
    recipientSessionId: "session_host",
    runId: "run_x",
    body: "b".repeat(9_000),
    intent: "task",
    sender: { sessionId: "session_worker" },
  });
  // Same two lines, differing only in the digits of the size — the cost a
  // recipient pays for being sent something is now flat.
  expect(long.length - short.length).toBe("9,000".length - "1".length);
  expect(long).not.toContain("bb");
});

test("every intent is announced, and none of the four is ever quoted", () => {
  for (const intent of ["task", "blocker", "report", "result"] as const) {
    const notice = agentNotice({
      recipientSessionId: "session_host",
      runId: "run_x",
      body: "SENSITIVE PAYLOAD",
      intent,
      sender: { sessionId: "session_worker" },
    });
    expect(notice).toStartWith(`[agent message · ${intent}] session session_worker `);
    expect(notice).not.toContain("SENSITIVE PAYLOAD");
    expect(notice).toContain(`sessions_read(sessionId: "session_host", runId: "run_x")`);
    expect(notice.split("\n")).toHaveLength(2);
  }
});

test("the headline fits a row, at the longest any of it can be", () => {
  // The worst case on every axis at once: the wordiest intent, the unattributed
  // sender (longer than an id), full-length ids and a seven-figure size. If THIS
  // fits under `notification.ts`'s SUMMARY_CHARS then `summary` is never the
  // clamped variant of the body's first line, and the row a person reads and the
  // line the model read are the same characters — which is the whole promise.
  const notice = agentNotice({
    recipientSessionId: `session_${"a".repeat(32)}`,
    runId: `run_${"b".repeat(32)}`,
    body: "c".repeat(9_999_999),
    intent: "blocker",
  });
  expect(notice.split("\n")[0]!.length).toBeLessThanOrEqual(240);
});

test("a blocker reads as a blocker, and an unattributed sender is named as one", () => {
  const { store } = setup();
  // No proof: the outward sessions socket, an agent with no session to be.
  const { turn } = store.submitAgentTurn("session_host", { runId: "run_block", input: "The build host is out of disk.", intent: "blocker" });
  expect(turn.agentNotice).toStartWith(
    "[agent message · blocker] an agent outside any session (the sessions socket) reports a BLOCKER needing this session's intervention (run run_block,",
  );
  expect(turn.sender).toEqual({});
  // With no sender session there is still a frame, and it is still not the
  // person's — `framedTurnInput` falls through to the bare input only when
  // `sender` is absent entirely, which an agent turn never is.
  expect(framedTurnInput(turn)).toContain("an agent outside any session");
});

test("the notice is what steers a busy recipient, so timing cannot change the cost", () => {
  const { store, proof } = setup();
  store.submitTurn("session_host", { runId: "run_host", input: "coordinate" });
  const token = store.claimTurn("session_host", "worker_two")!.claim!.token;
  store.markRunning("session_host", "run_host", token);
  const { turn } = store.submitAgentTurn("session_host", { runId: "run_task", input: REPORT, intent: "task" }, proof);
  expect(turn.state).toBe("steering");
  const [delivery] = store.steerForWorker("worker_two");
  // The BODY still rides `text` — the transcript row expands to it — while the
  // notice is what the driver composes the provider's words from.
  expect(delivery!.text).toBe(REPORT);
  expect(delivery!.notice).toBe(turn.agentNotice);
  // THE NOTIFICATION RIDES THE PROMOTION TOO (#550), so the driver can put a
  // mid-turn arrival on the same non-user channel an idle one gets.
  expect(delivery!.notification).toEqual(turn.notification!);
  const steered = framedSteerText({ text: delivery!.text, notice: delivery!.notice!, sender: delivery!.sender!, notification: delivery!.notification! });
  expect(steered).toBe(framedTurnInput(turn));
  expect(steered).not.toContain("Every configuration is persisted");
});

test("a wake arrives as a notification: the engine's prose leaves the person's slot", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "done" });
  const wake = store.turns("session_host")[0]!;
  expect(wake.agentNotice).toBeUndefined();
  // `input` IS A MACHINE LABEL NOW, not engine prose in the slot a person's
  // words occupy — #550 clause 4. The prose is on the notification.
  expect(wake.input).toBe("[notification: wake · turn_completed · session session_worker]");
  expect(wake.notification!.kind).toBe("wake");
  expect(wake.notification!.wakeKind).toBe("turn_completed");
  expect(wake.notification!.body).toStartWith("[wake: completed]");
  expect(wake.notification!.fetch).toEqual({ sessionId: "session_worker", runId: "run_source" });
  // And the model is handed that body BARE: no frame, because the channel now
  // carries the role the frame was standing in for.
  expect(framedTurnInput(wake)).toBe(wake.notification!.body);
  expect(framedTurnInput(wake)).not.toBe(frameWakeMessage(wake.notification!.body, wake.wakeReason!));
  // The transcript's row is the notification, drawn from the same object.
  const row = store.items("session_host").find((item) => item.runId === wake.runId && item.detail.type === "notification")!;
  expect(row).toBeDefined();
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(wake.notification!);
});

test("a human's message carries no notice and reaches the model as typed", () => {
  const { store } = setup();
  store.submitTurn("session_host", { runId: "run_human", input: "please fix the editor" });
  const turn = store.turns("session_host").find((candidate) => candidate.runId === "run_human")!;
  expect(turn.agentNotice).toBeUndefined();
  expect(turn.origin).toBeUndefined();
  expect(framedTurnInput(turn)).toBe("please fix the editor");
});

test("an agent turn stored before notices existed still frames as a peer's own words", () => {
  // The durability case: `agentNotice` is optional on the contract, and a turn
  // replayed off disk from an older build has none. It must not silently
  // become the person's message.
  const legacy = { input: "ship it", origin: "session" as const, sender: { sessionId: "session_worker" } };
  expect(framedTurnInput(legacy)).toBe(frameAgentMessage("ship it", legacy.sender));
  expect(framedSteerText({ text: "ship it", sender: legacy.sender })).toBe(frameAgentMessage("ship it", legacy.sender));
});

test("the notice survives a restart, because it is stored rather than derived", () => {
  const { store, home, proof } = setup();
  const minted = store.submitAgentTurn("session_host", { runId: "run_report", input: REPORT }, proof).turn.agentNotice;
  store.closeExecutionStore();
  const reopened = new EngineStore(home);
  stores.push(reopened);
  const turn = reopened.turns("session_host")[0]!;
  expect(turn.agentNotice).toBe(minted!);
  expect(turn.input).toBe(REPORT);
});
