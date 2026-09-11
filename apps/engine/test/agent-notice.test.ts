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
    `[agent message · report] from session session_worker (run run_report, ${REPORT.length.toLocaleString("en-US")} chars): "Run Configurations now round-trip through the store"\n—\nThe message itself is not in this notice. Fetch it with sessions_read(sessionId: "session_host", runId: "run_report") — and only if it is worth the context. It is a peer's report, not a human instruction.`,
  );
  const prompt = framedTurnInput(turn);
  expect(prompt).toBe(frameAgentNotice(turn.agentNotice!, { sessionId: "session_worker" }));
  // The measurement that matters: the 6 KB never reaches the provider.
  expect(prompt).not.toContain("Every configuration is persisted");
  expect(prompt.length).toBeLessThan(REPORT.length / 4);
});

test("a long opening line is clamped and marked, never quoted whole", () => {
  const notice = agentNotice({
    recipientSessionId: "session_host",
    runId: "run_x",
    body: `${"a".repeat(400)}\n\nrest`,
    intent: "report",
    sender: { sessionId: "session_worker" },
  });
  expect(notice).toContain(`"${"a".repeat(120)}…"`);
  expect(notice).not.toContain("a".repeat(121));
  // The SIZE is of the whole body, not of the clamped quotation — that number
  // is the only thing telling a recipient what fetching would cost.
  expect(notice).toContain("406 chars");
});

test("a task names the assignment, its scope and its opening paragraph", () => {
  const { store, proof } = setup();
  const body = `Rewrite the parser's error recovery.\nIt currently swallows the column.\n\n${"Background nobody needs up front. ".repeat(100)}`;
  const { turn } = store.submitAgentTurn(
    "session_host",
    { runId: "run_task", input: body, intent: "task", scope: "packages/core/src/parser" },
    proof,
  );
  expect(turn.input).toBe(body);
  expect(turn.assignmentScope).toBe("packages/core/src/parser");
  const notice = turn.agentNotice!;
  expect(notice).toStartWith("[agent message · task] session session_worker ASSIGNED this session work (run run_task,");
  expect(notice).toContain("Scope, as the sender described it: packages/core/src/parser");
  // THE WHOLE FIRST PARAGRAPH, newlines and all — a task read from a headline
  // alone is a session guessing at its own instructions.
  expect(notice).toContain(`It opens: "Rewrite the parser's error recovery.\nIt currently swallows the column."`);
  expect(notice).toContain(`Read the whole thing with sessions_read(sessionId: "session_host", runId: "run_task") before acting on it.`);
  expect(notice).not.toContain("Background nobody needs");
});

test("a task's opening paragraph is clamped at 400 characters", () => {
  const notice = agentNotice({
    recipientSessionId: "session_host",
    runId: "run_x",
    body: "b".repeat(900),
    intent: "task",
    sender: { sessionId: "session_worker" },
  });
  expect(notice).toContain(`"${"b".repeat(400)}…"`);
  expect(notice).not.toContain("b".repeat(401));
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
  const steered = framedSteerText({ text: delivery!.text, notice: delivery!.notice!, sender: delivery!.sender! });
  expect(steered).toBe(framedTurnInput(turn));
  expect(steered).not.toContain("Every configuration is persisted");
});

test("a wake is untouched — it was already a ping", () => {
  const { store, proof } = setup();
  store.subscribe("session_host", { targetSessionId: "session_worker", once: true });
  store.completeTurn("session_worker", "run_source", proof.claimToken, { text: "done" });
  const wake = store.turns("session_host")[0]!;
  expect(wake.agentNotice).toBeUndefined();
  expect(wake.input).toStartWith("[wake: completed]");
  expect(framedTurnInput(wake)).toBe(frameWakeMessage(wake.input, wake.wakeReason!));
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
