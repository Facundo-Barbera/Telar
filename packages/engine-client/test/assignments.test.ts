/**
 * WHAT A SESSION IS WORKING ON BEHALF OF, and the cases where a simpler model
 * would have got it wrong.
 *
 * The fold replaced a proposed "active assignment" field plus a pending queue.
 * Each case here is one of the reasons that model was rejected: two senders at
 * once, a steer that is terminal for the message but not for the work, a stop
 * that must not leave a session looking busy, and a detach that must not delete
 * the history a reviewer needs.
 */
import { expect, test } from "bun:test";
import { activeAssignments, assignmentsOf, reviewableAssignments, unresolvedAssignments, type AssignmentTurn } from "../src/protocol/assignments";
import { Turn } from "../src/protocol/entities";

const task = (runId: string, from: string, extra: Partial<AssignmentTurn> = {}): AssignmentTurn => ({
  runId,
  origin: "session",
  state: "running",
  sender: { sessionId: from },
  agentIntent: "task",
  agentSourceRunId: `${from}_run`,
  acceptedAt: 1,
  ...extra,
});

/**
 * A REAL `Turn`, NOT A HAND-WRITTEN SHAPE — issue #380.
 *
 * The fold read `turn.createdAt`, which no `Turn` has ever had. Every test above
 * passed because they all wrote the field the fold expected, and every caller in
 * the app passed a real turn and got `receivedAt: undefined` on an assignment
 * whose schema declares it required. Only a turn the SCHEMA produced can catch
 * that, so this one is parsed rather than typed.
 */
test("folding a real Turn gives an assignment a NUMBER for receivedAt", () => {
  const turn = Turn.parse({
    runId: "run_task",
    sessionId: "session_worker",
    sequence: 1,
    state: "running",
    input: "Implement the parser",
    origin: "session",
    sender: { sessionId: "session_coord" },
    agentIntent: "task",
    agentSourceRunId: "run_coord",
    acceptedAt: 1_789_328_886_517,
    updatedAt: 1_789_328_886_517,
  });
  const [assignment] = assignmentsOf([turn]);
  expect(typeof assignment?.receivedAt).toBe("number");
  expect(assignment?.receivedAt).toBe(turn.acceptedAt);
});

test("a task from a peer is an assignment; a report from the same peer is not", () => {
  // Treating a status update as an assignment is how a coordinator's report
  // would make a session look like somebody's employee.
  const turns: AssignmentTurn[] = [
    task("run_task", "session_coord"),
    { runId: "run_report", origin: "session", state: "completed", sender: { sessionId: "session_coord" }, agentIntent: "report", acceptedAt: 2 },
  ];
  expect(activeAssignments(turns).map((a) => a.taskRunId)).toEqual(["run_task"]);
});

test("a human turn is never an assignment", () => {
  const turns: AssignmentTurn[] = [{ runId: "run_user", state: "running", acceptedAt: 1 }];
  expect(assignmentsOf(turns)).toEqual([]);
});

test("TWO SENDERS are both outstanding — neither is overwritten, neither waits", () => {
  const turns = [task("run_a", "session_one"), task("run_b", "session_two")];
  const active = activeAssignments(turns);
  expect(active.map((a) => [a.taskRunId, a.fromSessionId])).toEqual([
    ["run_a", "session_one"],
    ["run_b", "session_two"],
  ]);
});

test("the sender's run and the recipient's task are DIFFERENT ids, and both are kept", () => {
  const [assignment] = activeAssignments([task("run_task", "session_coord", { assignmentScope: "engine only" })]);
  expect(assignment).toMatchObject({
    taskRunId: "run_task",
    sourceRunId: "session_coord_run",
    fromSessionId: "session_coord",
    scope: "engine only",
  });
});

test("a STEERED task follows the run it joined — delivery is not completion", () => {
  // `steered` is terminal for the MESSAGE and says nothing about the work.
  const turns: AssignmentTurn[] = [
    task("run_task", "session_coord", { state: "steered", steer: { intoRunId: "run_live" } }),
    { runId: "run_live", state: "running", acceptedAt: 0 },
  ];
  const active = activeAssignments(turns);
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({ taskRunId: "run_task", runId: "run_live" });

  // …and it ends when the JOINED run ends, not when the steer landed.
  const ended: AssignmentTurn[] = [turns[0]!, { runId: "run_live", state: "completed", acceptedAt: 0, completedAt: 9 }];
  expect(activeAssignments(ended)).toEqual([]);
  expect(reviewableAssignments(ended)[0]).toMatchObject({ outcome: "completed", endedAt: 9 });
});


test("completion, failure and stop each end the assignment with their own outcome", () => {
  for (const [state, outcome] of [["completed", "completed"], ["failed", "failed"], ["stopped", "stopped"]] as const) {
    const turns = [task("run_task", "session_coord", { state, completedAt: 5 })];
    expect(activeAssignments(turns)).toEqual([]);
    expect(reviewableAssignments(turns)[0]).toMatchObject({ outcome, endedAt: 5 });
  }
});

test("a stopped assignment leaves NO fake busy state", () => {
  // The failure this prevents: a session that was stopped still reporting that
  // it is working on someone's behalf.
  const turns = [task("run_task", "session_coord", { state: "stopped", completedAt: 5 })];
  expect(activeAssignments(turns)).toEqual([]);
});

test("finished work stays REVIEWABLE until settled", () => {
  // Related work must still offer a completed assignment: dropping it the
  // moment the run ended would hide the result the coordinator delegated for.
  const turns = [task("run_task", "session_coord", { state: "completed", completedAt: 5 })];
  expect(reviewableAssignments(turns)).toHaveLength(1);
});

test("CONTINUE INDEPENDENTLY detaches presentation without deleting history", () => {
  const turns = [task("run_task", "session_coord", { assignmentDetachedAt: 7 })];
  expect(activeAssignments(turns)).toEqual([]);
  // Not offered for review either — the human already decided.
  expect(reviewableAssignments(turns)).toEqual([]);
  // …but the record is intact, with who asked and what they asked for.
  expect(assignmentsOf(turns)[0]).toMatchObject({
    taskRunId: "run_task",
    fromSessionId: "session_coord",
    outcome: "detached",
    endedAt: 7,
  });
});

test("detaching a RUNNING assignment does not mark it finished", () => {
  // Detach is about presentation. It stops nothing, and must not claim the work
  // completed.
  const [assignment] = assignmentsOf([task("run_task", "session_coord", { state: "running", assignmentDetachedAt: 7 })]);
  expect(assignment?.outcome).toBe("detached");
});

test("a task with no engine-stamped sender is ignored", () => {
  // Attribution comes from a claim token. A turn without one cannot assert a
  // coordinator, and inventing one would be exactly the laundering this forbids.
  const turns: AssignmentTurn[] = [{ runId: "run_task", origin: "session", state: "running", agentIntent: "task", acceptedAt: 1 }];
  expect(assignmentsOf(turns)).toEqual([]);
});

test("a PAGED window cannot prove a carrier is running — it reports unknown", () => {
  // The correctness gap this replaced: falling back to the task turn both
  // renamed the run and asserted it was still going, so a completed carrier
  // that had paged out looked busy forever.
  const paged = [task("run_task", "session_coord", { state: "steered", steer: { intoRunId: "run_gone" } })];
  expect(activeAssignments(paged)).toEqual([]);
  const [assignment] = unresolvedAssignments(paged);
  expect(assignment).toMatchObject({ taskRunId: "run_task", runId: "run_gone", unresolved: true });
  // The joined id SURVIVES even though the run is absent — losing it would
  // rename the work.
  expect(assignment?.outcome).toBeUndefined();
});

test("the same turns folded over COMPLETE records resolve to the carrier's real outcome", () => {
  const complete: AssignmentTurn[] = [
    task("run_task", "session_coord", { state: "steered", steer: { intoRunId: "run_gone" } }),
    { runId: "run_gone", state: "completed", acceptedAt: 0, completedAt: 12 },
  ];
  expect(unresolvedAssignments(complete)).toEqual([]);
  expect(reviewableAssignments(complete)[0]).toMatchObject({ runId: "run_gone", outcome: "completed", endedAt: 12 });
});

test("a detached task whose carrier is absent is detached, not unknown", () => {
  // The human's decision is a fact we hold; it does not depend on the carrier.
  const turns = [task("run_task", "session_coord", { state: "steered", steer: { intoRunId: "run_gone" }, assignmentDetachedAt: 7 })];
  expect(unresolvedAssignments(turns)).toEqual([]);
  expect(assignmentsOf(turns)[0]).toMatchObject({ outcome: "detached", runId: "run_gone" });
});
