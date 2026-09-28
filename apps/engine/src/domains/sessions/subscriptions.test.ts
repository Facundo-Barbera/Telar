import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { INLINE_CHARS, RELAY_RULE } from "../turns";

const roots: string[] = [];

// A Claude default this temp home already knows, so a claim is not withheld waiting for a model list.
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): { store: EngineStore; root: string } {
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { store, root: stateRoot };
}

/** A second session beside `session_one`, and a helper that runs one turn on
 *  a session to completion the way a worker would. */
function pair(): { store: EngineStore } {
  const { store } = readyStore();
  store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
  return { store };
}
function runTurn(store: EngineStore, sessionId: string, runId: string, end: "complete" | "fail" | "stop" | "park" = "complete"): void {
  store.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  if (end === "complete") store.completeTurn(sessionId, runId, token, { text: "all done: " + "x".repeat(3_000) });
  if (end === "fail") store.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" });
  if (end === "stop") store.stopTurn(sessionId, runId);
  if (end === "park") {
    store.updateSession(sessionId, { runtimeMode: "approval-required" });
    store.openRequest(sessionId, runId, token, {
      requestId: "req_q",
      kind: "user_input",
      detail: { kind: "user_input", prompt: "Which database?", fields: [{ key: "db", label: "Database", kind: "choice", choices: ["postgres", "sqlite"] }] },
    });
  }
}
const wakes = (store: EngineStore, sessionId: string) => store.turns(sessionId).filter((turn) => turn.origin === "session");
// A wake's words live in the notification's `body`; `input` is a machine label.
const notice = (turn: Turn) => turn.notification?.body ?? turn.input;

test("a wake landing on a RUNNING subscriber is queued, never steered, and keeps its identity through requeue and pause (#194)", () => {
  // A wake steered into a running turn used to reach the model as the person typing; it must keep its identity.
  const { store } = pair();
  // THE SESSION-TOOLS AUDIT RETIRED THE STEER: only a person, a task or a
  // blocker interrupts a running turn, so even `always` queues its wake. The
  // identity invariant this test pins holds on the queued path.
  store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"], completionWake: "always" });
  // session_one is BUSY when the wake arrives — the whole point.
  store.submitTurn("session_one", { runId: "run_busy", input: "thinking" });
  const busy = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_busy", busy.claim!.token);

  runTurn(store, "session_two", "run_w");

  const [wake] = wakes(store, "session_one");
  expect(wake).toMatchObject({ origin: "session", state: "queued", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });
  expect(store.steerForWorker("worker_one").some((each) => each.steerRunId === wake!.runId)).toBe(false);
  // A person's steer beside it still interrupts, and stays exactly as bare.
  store.submitTurn("session_one", { runId: "run_typed", input: "and me" });
  const typed = store.steerForWorker("worker_one").find((each) => each.steerRunId === "run_typed")!;
  expect(typed.wakeReason).toBeUndefined();
  expect(typed.sender).toBeUndefined();

  // The running turn settles, and the wake is still a queued wake — it must
  // not come back as a human one.
  store.completeTurn("session_one", "run_busy", busy.claim!.token, { text: "done" });
  const requeued = store.turns("session_one").find((turn) => turn.runId === wake!.runId)!;
  expect(requeued).toMatchObject({ state: "queued", origin: "session", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });

  // AND ACROSS A PAUSE. A held wake is still a wake when the human resumes.
  store.pauseSession("session_one");
  const held = store.turns("session_one").find((turn) => turn.runId === wake!.runId)!;
  expect(held.origin).toBe("session");
  expect(held.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_two" });
  // Read cold, from a second store instance over the same files.
  const cold = new EngineStore(store.paths.root, () => 100).turns("session_one").find((turn) => turn.runId === wake!.runId)!;
  expect(cold.origin).toBe("session");
  expect(cold.wakeReason).toMatchObject({ kind: "turn_completed", sessionId: "session_two", runId: "run_w" });
});

test("a completed turn queues a wake with a BOUNDED excerpt of its answer, and the call that fetches the rest", () => {
  /**
   * A wake lands in the subscriber's context whether or not it needs the
   * answer, so it carries at most `INLINE_CHARS` of it. The child here answers
   * with 3 000 characters; the notice quotes the start, says how much is left,
   * and names the run-scoped read that fetches it.
   */
  const { store } = pair();
  const subscription = store.subscribe("session_one", { targetSessionId: "session_two" });
  expect(subscription.events).toEqual(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]);
  runTurn(store, "session_two", "run_w");

  const [wake] = wakes(store, "session_one");
  expect(wake).toMatchObject({ origin: "session", state: "queued", wakeReason: { kind: "turn_completed", sessionId: "session_two", runId: "run_w" } });
  expect(notice(wake!).startsWith("[wake: completed] Session session_two \"the worker\" — turn run_w completed.")).toBe(true);
  // The start of the answer, bounded, and how much was left out.
  expect(notice(wake!)).toContain("<<<\nall done");
  expect(notice(wake!)).not.toContain("x".repeat(INLINE_CHARS));
  expect(notice(wake!)).toMatch(/It begins \([\d,]+ more chars not shown\):/);
  // The quoted words are a session's, so the relay rule comes with them.
  expect(notice(wake!)).toContain(RELAY_RULE);
  // The whole notice stays bounded whatever the child wrote.
  expect(notice(wake!).length).toBeLessThan(INLINE_CHARS + 800);
  expect(notice(wake!)).toContain('sessions_read(sessionId: "session_two", runId: "run_w")');
  // The accept, then the notification's own row — written at accept rather
  // than when a provider gets round to it, so a queued wake is visible in the
  // transcript while the session is still busy. See `writeNotificationItem`.
  expect(store.readEvents("session_one").filter((event) => event.type === "turn.accepted").at(-1)).toMatchObject({
    type: "turn.accepted",
    turn: { origin: "session" },
  });
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "item.completed", item: { detail: { type: "notification" } } });
  // The file is at the engine root and outlives the store instance.
  expect(new EngineStore(store.paths.root, () => 100).subscriptionsFor("session_one")).toHaveLength(1);
});

test("failed, stopped and parked each wake with their own reason; a policy-resolved request wakes nobody", () => {
  const { store } = pair();
  store.subscribe("session_one", { targetSessionId: "session_two" });
  // Each wake is READ before the next lands — a still-queued one would take
  // the next with it (`joinWaitingNotification`), and this is about each notice.
  const read = () => {
    const claimed = store.claimTurn("session_one", "worker_one")!;
    store.markRunning("session_one", claimed.runId, claimed.claim!.token);
    store.completeTurn("session_one", claimed.runId, claimed.claim!.token, { text: "read" });
  };
  runTurn(store, "session_two", "run_f", "fail");
  read();
  runTurn(store, "session_two", "run_s", "stop");
  read();
  runTurn(store, "session_two", "run_p", "park");

  const kinds = wakes(store, "session_one").map((turn) => turn.wakeReason!.kind);
  expect(kinds).toEqual(["turn_failed", "turn_stopped", "request_opened"]);
  const [failed, , parked] = wakes(store, "session_one");
  expect(notice(failed!)).toContain("FAILED (driver_failed)");
  expect(notice(failed!)).toContain("the CLI died");
  expect(parked!.wakeReason).toMatchObject({ requestId: "req_q", runId: "run_p" });
  // The short title says what it is; the fields are a read away, not here.
  expect(notice(parked!)).toContain("Which database?");
  expect(notice(parked!)).not.toContain("choices:");
  // A PARKED REQUEST IS ITS OWN NOTIFICATION KIND — it is the one a recipient
  // can act on, and answering is a different verb from reading an outcome.
  expect(parked!.notification!.kind).toBe("request");
  expect(parked!.notification!.requestId).toBe("req_q");
  expect(failed!.notification!.kind).toBe("wake");
  expect(notice(parked!)).not.toContain("- db (choice)");
  expect(notice(parked!)).toContain('sessions_read(sessionId: "session_two", runId: "run_p")');
  expect(notice(parked!)).toContain("sessions_resolve_request");

  // Under `auto`, a command resolves itself — nothing parked, nothing to wake for.
  store.updateSession("session_two", { runtimeMode: "auto" });
  const token = store.turns("session_two").find((turn) => turn.runId === "run_p")!.claim!.token;
  store.openRequest("session_two", "run_p", token, { requestId: "req_auto", kind: "file_read", detail: { kind: "file_read", read: { path: "/x" } } });
  expect(wakes(store, "session_one")).toHaveLength(3);
});

test("a parked request's notice carries NO fields — only what it is, and the two calls", () => {
  /**
   * A PING, INCLUDING WHEN SOMETHING IS WAITING. The fields used to ride the
   * notice so an answer could be composed without a second read, which made
   * this the one notice whose size followed its payload. A coordinator about
   * to answer a question can afford the read it needs to answer properly.
   */
  const { store } = pair();
  store.subscribe("session_one", { targetSessionId: "session_two" });
  store.updateSession("session_two", { runtimeMode: "approval-required" });
  store.submitTurn("session_two", { runId: "run_many", input: "work" });
  const token = store.claimTurn("session_two", "worker_one")!.claim!.token;
  store.markRunning("session_two", "run_many", token);
  store.openRequest("session_two", "run_many", token, {
    requestId: "req_many",
    kind: "user_input",
    detail: {
      kind: "user_input",
      prompt: `Pick: ${"p".repeat(4_000)}`,
      fields: Array.from({ length: 30 }, (_, index) => ({
        key: `field_${index}`,
        label: `Label ${index} ${"l".repeat(500)}`,
        kind: "choice" as const,
        choices: Array.from({ length: 30 }, (_, choice) => `choice_${choice}_${"c".repeat(200)}`),
      })),
    },
  });

  const [parked] = wakes(store, "session_one");
  expect(notice(parked!).startsWith("[wake: waiting]")).toBe(true);
  // What it is: the request, its kind, a clamped title.
  expect(notice(parked!)).toContain("request req_many");
  expect(notice(parked!)).toContain("kind user_input");
  // NO fields, no choices, no counts of either — none of it is here.
  expect(notice(parked!)).not.toContain("field_0");
  expect(notice(parked!)).not.toContain("choices:");
  expect(notice(parked!)).not.toContain("more fields");
  expect(notice(parked!)).not.toContain("l".repeat(300));
  expect(notice(parked!)).not.toContain("c".repeat(300));
  // Both calls, and a notice that stays one however big the request was.
  expect(notice(parked!)).toContain('sessions_read(sessionId: "session_two", runId: "run_many")');
  expect(notice(parked!)).toContain("sessions_resolve_request");
  expect(notice(parked!).length).toBeLessThan(800);

  // The length does not follow the payload: ten times the fields gives the same notice, to the character.
  // Captured before the first turn ends: finishing it REWRITES that wake in
  // place (the coalescing rule), and the string under comparison is this one.
  const captured = notice(parked!);
  const first = store.turns("session_two").find((turn) => turn.runId === "run_many")!.claim!.token;
  store.resolveRequest("session_two", "req_many", { decision: "accept" });
  store.completeTurn("session_two", "run_many", first, { text: "" });
  // Read, so the next request's wake is a turn of its own rather than a line
  // joined to this one.
  const reading = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", reading.runId, reading.claim!.token);
  store.completeTurn("session_one", reading.runId, reading.claim!.token, { text: "read" });

  store.submitTurn("session_two", { runId: "run_huge_req", input: "work" });
  const second = store.claimTurn("session_two", "worker_one")!.claim!.token;
  store.markRunning("session_two", "run_huge_req", second);
  store.openRequest("session_two", "run_huge_req", second, {
    requestId: "req_bigger",
    kind: "user_input",
    detail: {
      kind: "user_input",
      prompt: `Pick: ${"p".repeat(40_000)}`,
      fields: Array.from({ length: 300 }, (_, index) => ({
        key: `field_${index}`,
        label: `Label ${index} ${"l".repeat(5_000)}`,
        kind: "choice" as const,
        choices: Array.from({ length: 300 }, (_, choice) => `choice_${choice}_${"c".repeat(2_000)}`),
      })),
    },
  });
  const bigger = wakes(store, "session_one").find((turn) => turn.wakeReason?.runId === "run_huge_req");
  // Within a few characters — the ids differ in length and nothing else can.
  // The payload grew by two orders of magnitude; the notice did not grow.
  expect(Math.abs(notice(bigger!).length - captured.length)).toBeLessThan(20);
  expect(notice(bigger!)).not.toContain("l".repeat(300));
  expect(notice(bigger!)).not.toContain("c".repeat(300));
});

test("events narrows; once fires once; subscribing twice merges into one", () => {
  const { store } = pair();
  const first = store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_failed"] });
  const second = store.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"], once: true });
  expect(second.id).toBe(first.id);
  expect(second.events.sort()).toEqual(["turn_completed", "turn_failed"]);
  expect(store.subscriptionsFor("session_one")).toHaveLength(1);

  runTurn(store, "session_two", "run_1", "stop");
  expect(wakes(store, "session_one")).toHaveLength(0);
  runTurn(store, "session_two", "run_2");
  expect(wakes(store, "session_one")).toHaveLength(1);
  expect(store.subscriptionsFor("session_one")).toHaveLength(0);
  runTurn(store, "session_two", "run_3");
  expect(wakes(store, "session_one")).toHaveLength(1);
});

test("a second event from the same target REWRITES the waiting wake in place rather than queueing a twin", () => {
  const { store } = pair();
  store.subscribe("session_one", { targetSessionId: "session_two" });
  // Park → the first wake. Then the same turn's approval is answered and it finishes → the second event.
  runTurn(store, "session_two", "run_p", "park");
  const [parked] = wakes(store, "session_one");
  expect(notice(parked!).startsWith("[wake: waiting]")).toBe(true);
  expect(parked!.wakeReason).toMatchObject({ kind: "request_opened", requestId: "req_q" });

  store.resolveRequest("session_two", "req_q", { decision: "accept", answers: { db: "postgres" } });
  const token = store.turns("session_two").find((turn) => turn.runId === "run_p")!.claim!.token;
  store.completeTurn("session_two", "run_p", token, { text: "done" });

  const after = wakes(store, "session_one");
  expect(after).toHaveLength(1);
  expect(after[0]!.runId).toBe(parked!.runId);
  expect(notice(after[0]!).startsWith("[wake: completed]")).toBe(true);
  // The ROW moved with the turn: a transcript showing the superseded line
  // beside a turn that announces something else is the same lie, drawn.
  expect(after[0]!.notification!.wakeKind).toBe("turn_completed");
  const row = store.items("session_one").find((item) => item.runId === after[0]!.runId && item.detail.type === "notification")!;
  expect((row.detail as Extract<typeof row.detail, { type: "notification" }>).notification).toEqual(after[0]!.notification!);
  expect(after[0]!.wakeReason).toMatchObject({ kind: "turn_completed", runId: "run_p" });
  expect(after[0]!.wakeReason).not.toHaveProperty("requestId");
  // The rewrite is announced as a replay of the same run, so a client redraws the chip.
  const events = store.readEvents("session_one").filter((event) => event.type === "turn.accepted" && event.runId === parked!.runId);
  expect(events).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ replayed: true });

  // AND THE REWRITE IS BOUNDED THE SAME WAY. The notice that replaced the
  // parked one quotes the answer exactly as a first notice would, and names
  // the run-scoped read.
  expect(notice(after[0]!)).toContain("In full:\n<<<\ndone\n>>>");
  expect(notice(after[0]!)).toContain('sessions_read(sessionId: "session_two", runId: "run_p")');
  expect(notice(after[0]!).length).toBeLessThan(800);

  // A wake the worker already CLAIMED is not rewritten — and under
  // `settled_only` (#550) a fresh one does not queue behind it either: the
  // subscriber is BUSY, so it is held until that turn settles.
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", claimed.runId, claimed.claim!.token);
  runTurn(store, "session_two", "run_next");
  expect(wakes(store, "session_one")).toHaveLength(1);
  expect(store.pendingNotifications("session_one").map((each) => each.runId)).toEqual(["run_next"]);
  // And settling it delivers what was held, as its own turn.
  store.completeTurn("session_one", claimed.runId, claimed.claim!.token, { text: "read it" });
  const delivered = wakes(store, "session_one").find((turn) => turn.notification?.runId === "run_next");
  expect(delivered).toBeDefined();
  expect(store.pendingNotifications("session_one")).toHaveLength(0);
});

test("unsubscribe withdraws the wakes still waiting from that session, and leaves everything else", () => {
  const { store } = pair();
  store.createSession({ id: "session_three", projectId: "project_one", title: "another" });
  const two = store.subscribe("session_one", { targetSessionId: "session_two" });
  store.subscribe("session_one", { targetSessionId: "session_three" });
  store.submitTurn("session_one", { runId: "run_mine", input: "my own message" });
  runTurn(store, "session_two", "run_a");
  runTurn(store, "session_three", "run_b");
  // Both wakes share one queued turn (`joinWaitingNotification`).
  const [joined] = wakes(store, "session_one");
  expect(wakes(store, "session_one")).toHaveLength(1);
  expect(joined!.notification!.entries?.map((entry) => entry.sessionId)).toEqual(["session_two", "session_three"]);

  // Unsubscribing takes session_two's line OUT of it and leaves the rest.
  expect(store.unsubscribe(two.id, "session_one")).toBe(true);
  const turns = store.turns("session_one");
  const kept = turns.find((turn) => turn.runId === joined!.runId)!;
  expect(kept.state).toBe("queued");
  expect(kept.notification!.entries?.map((entry) => entry.sessionId)).toEqual(["session_three"]);
  expect(kept.wakeReason).toMatchObject({ sessionId: "session_three", runId: "run_b" });
  expect(notice(kept)).not.toContain("session_two");
  expect(turns.find((turn) => turn.runId === "run_mine")!.state).toBe("queued");
  expect(store.readEvents("session_one").filter((event) => event.type === "turn.discarded")).toHaveLength(0);

  // A turn with nothing but the unsubscribed session's news still goes whole.
  store.unsubscribe(store.subscriptionsFor("session_one")[0]!.id, "session_one");
  expect(store.turns("session_one").find((turn) => turn.runId === joined!.runId)!.state).toBe("discarded");
});

test("a wake's own ending wakes nobody, so two sessions subscribed to each other cannot ping-pong", () => {
  const { store } = pair();
  store.subscribe("session_one", { targetSessionId: "session_two" });
  store.subscribe("session_two", { targetSessionId: "session_one" });
  runTurn(store, "session_two", "run_w");
  const [wake] = wakes(store, "session_one");
  expect(wake).toBeDefined();
  // Run the wake turn itself to completion: nothing comes back to two.
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", wake!.runId, token);
  store.completeTurn("session_one", wake!.runId, token, { text: "noted" });
  expect(wakes(store, "session_two")).toHaveLength(0);
});

test("an archived subscriber is dropped; a full backlog drops the wake with a warning; the target's transition still succeeds", () => {
  const { store } = pair();
  store.createSession({ id: "session_three", projectId: "project_one" });
  store.subscribe("session_one", { targetSessionId: "session_two" });
  store.subscribe("session_three", { targetSessionId: "session_two" });
  store.archiveSession("session_three");
  // Archiving takes the wish with it, in both directions.
  expect(store.subscriptionsFor("session_one")).toHaveLength(1);
  expect(new EngineStore(store.paths.root, () => 100).subscriptionsFor("session_one")).toHaveLength(1);

  for (let n = 0; n < 16; n++) store.submitTurn("session_one", { runId: `run_fill_${n}`, input: "queued" });
  runTurn(store, "session_two", "run_w");
  expect(store.turns("session_two").at(-1)!.state).toBe("completed");
  expect(wakes(store, "session_one")).toHaveLength(0);
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "runtime.warning" });
  expect(String((store.readEvents("session_one").at(-1) as { message: string }).message)).toContain("was dropped");
});

test("the rules: no self-subscribe, no archived target, a wake must carry its reason, and origin cannot be forged through submitTurn alone", () => {
  const { store } = pair();
  expect(() => store.subscribe("session_one", { targetSessionId: "session_one" })).toThrow(/cannot subscribe to itself/);
  store.archiveSession("session_two");
  expect(() => store.subscribe("session_one", { targetSessionId: "session_two" })).toThrow(/archived/);
  /**
   * THE GUARD IS EXACTLY-ONE-COMPANION, and #543 widened it from two
   * companions to three rather than dropping it to let a clock through. Both
   * directions are pinned here, because the half that refuses a bare origin
   * is satisfied by a guard that refuses everything.
   */
  expect(() => store.submitTurn("session_one", { runId: "run_x", input: "x", origin: "session" })).toThrow(/exactly one companion/);
  // A schedule origin with no `scheduleOrigin` is the same refusal…
  expect(() => store.submitTurn("session_one", { runId: "run_y", input: "y", origin: "schedule" })).toThrow(/exactly one companion/);
  // …and a companion with NO origin is refused from the other side, which is
  // what keeps `scheduleOrigin` from being smuggled onto an ordinary turn.
  expect(() =>
    store.submitTurn("session_one", { runId: "run_z", input: "z", scheduleOrigin: { scheduleId: "sched_1", dueAt: 1 } }),
  ).toThrow(/exactly one companion/);
  expect(() => store.unsubscribe("sub_nope")).not.toThrow();
  expect(store.unsubscribe("sub_nope")).toBe(false);
});

test("a request answered by a session is journaled as such", () => {
  const { store } = pair();
  runTurn(store, "session_two", "run_p", "park");
  const answered = store.resolveRequest("session_two", "req_q", { decision: "accept", resolvedBy: "session", answers: { db: "postgres" } });
  expect(answered.resolvedBy).toBe("session");
  expect(store.readEvents("session_two").at(-1)).toMatchObject({ type: "request.resolved", resolvedBy: "session" });
});
