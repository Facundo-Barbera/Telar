/**
 * THE DELEGATION SETTLE OVER A REAL STORE — issue #378.
 *
 * `delegation-settling.test.ts` proves the rule. It cannot prove the thing that
 * actually decides whether this feature works: that the engine GATHERS the
 * facts the rule needs from turns it really wrote — a task handed over through
 * `submitAgentTurn`, a result sent back with a live claim, a wake queued by
 * `fireSubscriptions` and consumed by a turn that completed.
 *
 * So every case here is built out of the engine's own verbs, and the clock is
 * the store's own, moved forward to let the grace pass.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const HOUR = 60 * 60 * 1000;
const START = 1_000 * HOUR;

const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Scene = ReturnType<typeof scene>;

function scene() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-delegation-"));
  roots.push(directory);
  // A Claude default this temp home already knows, so a claim is not withheld
  // waiting for a model list nobody is going to read here.
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let now = START;
  const store = new EngineStore(directory, () => now);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_coord", projectId: "project_one", title: "The coordinator" });
  store.createSession({ id: "session_worker", projectId: "project_one", title: "The delegate" });
  return {
    store,
    /** Move the store's clock. The grace is the whole point of this feature. */
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

/** A task handed over with engine-stamped attribution, as `sessions_send` does. */
function handOver({ store }: Scene, runId: string, coordinatorRunId = "run_coord_1") {
  store.submitTurn("session_worker", {
    runId,
    input: "do the thing",
    origin: "session",
    sender: { sessionId: "session_coord" },
    agentIntent: "task",
    agentDelivery: "wake",
    agentSourceRunId: coordinatorRunId,
  } as never);
}

/** Claim and start a turn, handing back the token the rest of the run needs. */
function start({ store }: Scene, sessionId: string, runId: string): string {
  const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  return token;
}

/**
 * The delegate reporting back and finishing — the ordinary shape of a delivered
 * errand. The result is sent from INSIDE the run, which is what stamps the
 * coordinator's turn with `agentSourceRunId`.
 */
function deliver(fixture: Scene, runId: string, resultRunId = "run_result") {
  const token = start(fixture, "session_worker", runId);
  fixture.store.submitAgentTurn(
    "session_coord",
    { runId: resultRunId, input: "here is the answer", intent: "result" },
    { sessionId: "session_worker", runId, claimToken: token },
  );
  fixture.store.completeTurn("session_worker", runId, token, { text: "done" });
  /**
   * AND THE COORDINATOR READS IT — #631 part 2.
   *
   * A result to an IDLE coordinator used to complete on arrival and reach no
   * model, so these scenes could go straight on to archiving or to the
   * coordinator's next turn. It is a real turn now, and in production a worker
   * picks it up within the poll. Running it here is the fixture catching up
   * with reality rather than working around it: a coordinator with an unread
   * message really does have an active turn, and archiving really does have to
   * wait for it.
   */
  const coordinatorToken = fixture.store.claimTurn("session_coord", "worker_coord")?.claim?.token;
  if (coordinatorToken) {
    fixture.store.markRunning("session_coord", resultRunId, coordinatorToken);
    fixture.store.completeTurn("session_coord", resultRunId, coordinatorToken, { text: "read" });
  }
}

/** Run a turn on a session start to finish. */
function runTurn(fixture: Scene, sessionId: string, runId: string, input = "…") {
  const queued = fixture.store.turns(sessionId).some((turn) => turn.runId === runId);
  if (!queued) fixture.store.submitTurn(sessionId, { runId, input });
  const token = start(fixture, sessionId, runId);
  fixture.store.completeTurn(sessionId, runId, token, { text: "ok" });
}

const worker = ({ store }: Scene) => store.getSession("session_worker");

test("DELIVERED → SETTLES AFTER THE GRACE, and the row says whose work it was", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");

  // Not yet: the coordinator has it, but the grace is the reader's chance to
  // notice the answer before the row recedes.
  expect(worker(fixture).settledOverride).toBeUndefined();

  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);

  const settled = worker(fixture);
  expect(settled.settledOverride).toBe("settled");
  expect(settled.settledBy).toEqual({
    kind: "delegation",
    coordinatorSessionId: "session_coord",
    runId: "run_task",
    at: START,
  });
  // The reason is journalled once, for anything that wants to act on the
  // settling rather than re-derive it from two snapshots.
  const events = fixture.store.readEvents("session_worker", 0);
  expect(events.filter((event) => event.type === "session.settled")).toHaveLength(1);
  // Idempotent: a second sweep finds a standing decision and leaves it alone.
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
});

test("DELIVERED THEN RE-TASKED → stays, because the new assignment is outstanding", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.advance(HOUR + 1);
  // The coordinator read the answer and asked for more.
  handOver(fixture, "run_task_2", "run_coord_2");

  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBeUndefined();
});

test("DELIVERED THEN HUMAN UN-SETTLED → never re-settles that errand", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.advance(HOUR + 1);
  fixture.store.sweepDelegatedSettling();
  expect(worker(fixture).settledOverride).toBe("settled");

  // The two patches the row's own undo sends: pin it back into the list, then
  // return it to the rule.
  fixture.store.updateSession("session_worker", { settledOverride: "active" });
  fixture.store.updateSession("session_worker", { settledOverride: null });
  const released = worker(fixture);
  expect(released.settledOverride).toBeUndefined();
  expect(released.settledBy).toBeUndefined();
  expect(released.unsettledAssignments).toEqual(["run_task"]);

  fixture.advance(10 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBeUndefined();

  // A NEW ERRAND IS A NEW ARGUMENT. The record is scoped to the assignment
  // somebody disagreed about, not to the session for ever.
  handOver(fixture, "run_task_2", "run_coord_2");
  deliver(fixture, "run_task_2", "run_result_2");
  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);
  expect(worker(fixture).settledBy?.runId).toBe("run_task_2");
});

test("A MESSAGE TYPED AT A SETTLED DELEGATE LIFTS THE SHELF, and it does not snap back", () => {
  // The same protection as the un-settle above, through the other door: the
  // facts behind the settle are permanent, so without the record the row would
  // re-shelve itself the moment the person's turn ended.
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.advance(HOUR + 1);
  fixture.store.sweepDelegatedSettling();

  runTurn(fixture, "session_worker", "run_human", "one more thing");
  expect(worker(fixture).settledOverride).toBeUndefined();
  fixture.advance(10 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
});

test("A FAILED ASSIGNMENT STAYS. Nothing hides the row a coordinator may still owe", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  const token = start(fixture, "session_worker", "run_task");
  fixture.store.submitAgentTurn(
    "session_coord",
    { runId: "run_result", input: "it broke", intent: "blocker" },
    { sessionId: "session_worker", runId: "run_task", claimToken: token },
  );
  fixture.store.failTurn("session_worker", "run_task", token, { code: "driver_failed", message: "boom" });

  fixture.advance(100 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBeUndefined();
});

test("DETACHED → SETTLES. A human already said this is nobody's errand", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  // The work ran and NOTHING WAS EVER DELIVERED — no result, no subscriber, no
  // wake. Detaching is the only thing that ends this errand, and without the
  // detach carve-out the row would wait for a delivery nobody is going to send.
  const token = start(fixture, "session_worker", "run_task");
  fixture.store.completeTurn("session_worker", "run_task", token, { text: "done" });
  fixture.store.detachAssignments("session_worker");

  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);
  expect(worker(fixture).settledBy?.runId).toBe("run_task");
});

test("PINNED → STAYS. Both directions of the override are decisions", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.store.updateSession("session_worker", { settledOverride: "active" });

  fixture.advance(100 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBe("active");
});

test("A PARKED REQUEST STAYS — the precedence the whole settling system is built on", () => {
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.advance(HOUR + 1);

  // A later turn on the delegate parks a QUESTION nobody has answered — the
  // one request kind no runtime mode auto-resolves.
  fixture.store.submitTurn("session_worker", { runId: "run_after", input: "more" });
  const token = start(fixture, "session_worker", "run_after");
  fixture.store.openRequest("session_worker", "run_after", token, {
    requestId: "req_open",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "which branch?", fields: [] },
  });

  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).activity).toBe("blocked");
  expect(worker(fixture).settledOverride).toBeUndefined();
});

test("A COORDINATOR ARCHIVED AFTER DELIVERY → the delegate still settles", () => {
  // Delivery already happened. Ending the conversation that received it does
  // not un-receive it, and the delegate must not be stranded by its
  // coordinator's lifecycle.
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.store.archiveSession("session_coord");

  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);
  expect(worker(fixture).settledBy?.coordinatorSessionId).toBe("session_coord");
});

test("A CONSUMED WAKE IS DELIVERY, and a wake that also re-tasked is not", () => {
  const fixture = scene();
  fixture.store.subscribe("session_coord", { targetSessionId: "session_worker" });
  handOver(fixture, "run_task");

  // The delegate finishes with no `result` — the wake is the only delivery.
  const token = start(fixture, "session_worker", "run_task");
  fixture.store.completeTurn("session_worker", "run_task", token, { text: "done" });
  const wake = fixture.store.turns("session_coord").find((turn) => turn.wakeReason?.runId === "run_task");
  expect(wake).toBeDefined();

  // While the wake is still queued, nothing has been delivered.
  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);

  // THE COORDINATOR CONSUMES IT AND IMMEDIATELY SENDS A NEW TASK. Delivery
  // happened, and the row stays anyway: the new errand is outstanding.
  const coordToken = start(fixture, "session_coord", wake!.runId);
  handOver(fixture, "run_task_2", wake!.runId);
  fixture.store.completeTurn("session_coord", wake!.runId, coordToken, { text: "keep going" });
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);

  // Once THAT errand finishes and is delivered, the row settles on the wake.
  const second = start(fixture, "session_worker", "run_task_2");
  fixture.store.completeTurn("session_worker", "run_task_2", second, { text: "done" });
  const secondWake = fixture.store.turns("session_coord").find((turn) => turn.wakeReason?.runId === "run_task_2");
  const secondToken = start(fixture, "session_coord", secondWake!.runId);
  fixture.store.completeTurn("session_coord", secondWake!.runId, secondToken, { text: "thanks" });

  fixture.advance(HOUR + 1);
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);
  expect(worker(fixture).settledBy?.runId).toBe("run_task_2");
});

test("GRACE null → OFF. Nothing settles by itself, however long it has been", () => {
  const fixture = scene();
  fixture.store.setInboxPolicy({ settleDelegatedAfterHours: null });
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");

  fixture.advance(1_000 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBeUndefined();

  // …and turning it back on settles the row that was waiting all along.
  fixture.store.setInboxPolicy({ settleDelegatedAfterHours: 1 });
  expect(fixture.store.sweepDelegatedSettling()).toEqual(["session_worker"]);
});

test("A TURN COMPLETING SETTLES WITHOUT WAITING FOR THE SWEEP, once the grace has passed", () => {
  // The sweep is the backstop for a quiet store. The evaluation points are
  // what make the common case immediate — here, the coordinator's own turn.
  const fixture = scene();
  handOver(fixture, "run_task");
  deliver(fixture, "run_task");
  fixture.advance(HOUR + 1);

  runTurn(fixture, "session_coord", "run_coord_later", "unrelated thinking");
  expect(worker(fixture).settledOverride).toBe("settled");
});

test("A SESSION NOBODY DELEGATED TO IS NEVER TOUCHED", () => {
  const fixture = scene();
  runTurn(fixture, "session_worker", "run_own", "my own idea");
  fixture.advance(1_000 * HOUR);
  expect(fixture.store.sweepDelegatedSettling()).toEqual([]);
  expect(worker(fixture).settledOverride).toBeUndefined();
});

test("the delegation grace is its own setting, and survives a reload beside the quiet window", () => {
  const fixture = scene();
  expect(fixture.store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72, settleDelegatedAfterHours: 1 });
  fixture.store.setInboxPolicy({ settleDelegatedAfterHours: 6 });
  expect(fixture.store.getInboxPolicy()).toEqual({ autoSettleAfterHours: 72, settleDelegatedAfterHours: 6 });
  // Changing one leaves the other exactly where it was.
  fixture.store.setInboxPolicy({ autoSettleAfterHours: null });
  expect(fixture.store.getInboxPolicy()).toEqual({ autoSettleAfterHours: null, settleDelegatedAfterHours: 6 });
  expect(() => fixture.store.setInboxPolicy({ settleDelegatedAfterHours: 0 })).toThrow();
});
