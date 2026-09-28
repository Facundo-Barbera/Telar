import { describe, expect, test } from "bun:test";
import path from "node:path";
import { EngineStateError, EngineStore } from "../../state";
import type { ExecutionStore } from "../../platform/db/execution-store";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
}

test("submitting a stable run id is idempotent and a session has only one active turn", () => {
  const { store } = readyStore();
  const initial = store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(initial.replayed).toBe(false);
  expect(store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" })).toEqual({ ...initial, replayed: true });
  expect(() => store.intake.submitTurn("session_one", { runId: "run_one", input: "Different" })).toThrow(EngineStateError);
  expect(store.queries.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);

  // A SECOND SUBMISSION IS NOW ACCEPTED AND QUEUED, where it used to be a
  // conflict. What has NOT changed is that only one turn ever executes:
  // `claimTurn` refuses while another is claimed or running, which the
  // queue-drain test below pins. The old assertion here described the
  // waiting, not the invariant.
  const queued = store.intake.submitTurn("session_one", { runId: "run_two", input: "Second" });
  expect(queued.turn.state).toBe("queued");
});

test("a message while a turn runs STEERS into it; one that cannot be delivered runs next, in order", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "First" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claimed.claim!.token);

  // THE POINT: typing at a running turn reaches it — the same turn continues,
  // as it does in T3 Code and at any running CLI. Nothing waits for "Send now".
  const second = store.intake.submitTurn("session_one", { runId: "run_two", input: "Second" });
  expect(second.turn).toMatchObject({ state: "steering", steer: { intoRunId: "run_one" } });
  expect(store.queries.readEvents("session_one").slice(-2).map((event) => event.type)).toEqual(["turn.accepted", "turn.steering"]);
  store.intake.submitTurn("session_one", { runId: "run_three", input: "Third" });

  // Still exactly ONE turn executing: nothing may be claimed while one runs.
  expect(store.claims.claimNextTurn("worker_two")).toBeUndefined();

  // The worker delivers the first; the turn ends before the second lands.
  store.turnLifecycle.ackSteer("session_one", "run_two", claimed.claim!.token);
  store.turnLifecycle.completeTurn("session_one", "run_one", claimed.claim!.token, { text: "done" });
  const turns = new Map(store.queries.turns("session_one").map((turn) => [turn.runId, turn]));
  expect(turns.get("run_two")?.state).toBe("steered");
  // NOT LOST: the undelivered one is back to queued and runs as its own turn.
  expect(turns.get("run_three")?.state).toBe("queued");
  expect(store.claims.claimNextTurn("worker_two")?.turn.runId).toBe("run_three");

  // A message to an IDLE session is the next turn, as before.
  const { store: idle } = readyStore();
  expect(idle.intake.submitTurn("session_one", { runId: "run_solo", input: "Hello" }).turn.state).toBe("queued");
  // A claimed-but-not-yet-running turn is not steerable either: queued, not lost.
  idle.claims.claimTurn("session_one", "worker_one");
  expect(idle.intake.submitTurn("session_one", { runId: "run_early", input: "and this" }).turn.state).toBe("queued");
});

test("a compaction is a kind of turn, and only one may be in flight", () => {
  const { store } = readyStore();
  const first = store.intake.submitTurn("session_one", { runId: "run_c1", input: "/compact", kind: "compact" });
  expect(first.turn.kind).toBe("compact");
  // A second press while the first is queued: refused, not queued behind it.
  expect(() => store.intake.submitTurn("session_one", { runId: "run_c2", input: "/compact", kind: "compact" })).toThrow(
    "a compaction is already queued or running",
  );
  // An ordinary message is still welcome behind it.
  const message = store.intake.submitTurn("session_one", { runId: "run_m1", input: "hello" });
  expect(message.turn.kind).toBeUndefined();
  // Once the compaction settles, another may be asked for.
  const claim = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_c1", claim.turn.claim!.token);
  store.turnLifecycle.completeTurn("session_one", "run_c1", claim.turn.claim!.token, { text: "" });
  expect(store.intake.submitTurn("session_one", { runId: "run_c3", input: "/compact", kind: "compact" }).turn.kind).toBe("compact");
});

describe("a message typed into a session that had already been claimed", () => {
  // A message arriving between claim and `markTurnRunning` must still steer. The boundary is
  // submission order, not time: on this frozen clock a claim and a message share a millisecond.
  test("the same-millisecond case: submitted after the claim, steered into that turn when it starts", () => {
    const { store } = readyStore();
    // Everything below happens at t=100. Order is all that distinguishes it.
    store.intake.submitTurn("session_one", { runId: "run_live", input: "do the thing" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    expect(claim.runId).toBe("run_live");
    // `run_live` took sequence 1, so the next message will be 2 — and that is
    // the watermark: at or above it means "written after this claim".
    expect(claim.claim!.sequence).toBe(2);

    store.intake.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });
    // Still no provider to steer into, exactly as before.
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");

    store.turnLifecycle.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_typed")).toMatchObject({
      state: "steering",
      steer: { intoRunId: "run_live" },
    });
    // A real delivery, not a state flip: the worker is told.
    expect(store.worker.steerForWorker("worker_one").find((each) => each.steerRunId === "run_typed")).toMatchObject({
      runId: "run_live",
      text: "Hello?",
    });
    // And the journal says the turn began before anything was steered into it.
    const events = store.queries.readEvents("session_one");
    const started = events.findIndex((event) => event.type === "turn.started" && event.runId === "run_live");
    const steering = events.findIndex((event) => event.type === "turn.steering" && event.runId === "run_typed");
    expect(started).toBeGreaterThan(-1);
    expect(steering).toBeGreaterThan(started);
  });

  test("a backlog written BEFORE the claim stays a backlog", () => {
    // Its author was not steering anything — the session was idle when they
    // wrote it. Sweeping it in would collapse a queued conversation into one
    // turn, which is a different bug in the opposite direction.
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_first", input: "do the thing" });
    store.intake.submitTurn("session_one", { runId: "run_backlog", input: "then this" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    store.turnLifecycle.markRunning("session_one", "run_first", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_backlog")!.state).toBe("queued");
    expect(store.worker.steerForWorker("worker_one")).toEqual([]);
  });

  test("a STOP before the start ends the claim, so the start is refused and the late message is settled", () => {
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    store.intake.submitTurn("session_one", { runId: "run_late", input: "typed late" });
    store.turnLifecycle.stopSession("session_one");

    // The claimed turn was stopped, so there is nothing left to start.
    expect(() => store.turnLifecycle.markRunning("session_one", "run_live", claim.claim!.token)).toThrow(EngineStateError);
    // And the message written into the window is settled with it — not held
    // for a decision, and not left to run by itself later.
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_late")).toMatchObject({ state: "stopped", stopReason: "user" });
    expect(store.claims.claimTurn("session_one", "worker_two")).toBeUndefined();
  });

  test("a STOP after the start takes the steered message with it", () => {
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    store.intake.submitTurn("session_one", { runId: "run_late", input: "typed late" });
    store.turnLifecycle.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_late")?.state).toBe("steering");

    store.turnLifecycle.stopSession("session_one");
    const late = store.queries.turns("session_one").find((turn) => turn.runId === "run_late")!;
    // Undelivered, so it ends here rather than going back to the queue to be
    // claimed a heartbeat later — which is what made Stop start the next thing.
    expect(late).toMatchObject({ state: "stopped", stopReason: "user", input: "typed late" });
    expect(late.held).toBeUndefined();
  });

  test("a CLAIMED COMPACTION takes no message: there is no conversation to interrupt", () => {
    // The target being a compaction is the same refusal `promoteTurn` makes
    // from the other side, and Codex rejects steering a compact turn at the
    // protocol level.
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_squeeze", input: "/compact", kind: "compact" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    expect(claim.runId).toBe("run_squeeze");
    store.intake.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });
    store.turnLifecycle.markRunning("session_one", "run_squeeze", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
    expect(store.worker.steerForWorker("worker_one")).toEqual([]);
  });

  test("a COMPACTION submitted into the window still waits its turn", () => {
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    store.intake.submitTurn("session_one", { runId: "run_squeeze", input: "/compact", kind: "compact" });
    store.turnLifecycle.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_squeeze")!.state).toBe("queued");
  });

  test("a target REQUEUED and claimed again does not inherit the old window's messages", () => {
    // A re-claim takes a new watermark, so a message written into the abandoned attempt
    // queues as an ordinary message instead of steering into a turn that never saw it.
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const first = store.claims.claimTurn("session_one", "worker_one")!;
    expect(first.claim!.sequence).toBe(2);
    store.intake.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });

    /**
     * The worker vanishes before it ever marked the turn running. Its claim
     * ENDS with it: requeueing would replay work nobody asked to re-run, and
     * leaving it `claimed` would block the session for ever behind a worker
     * that no longer exists.
     */
    store.recovery.retireWorkerRegistration("worker_one");
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_live")).toMatchObject({
      state: "stopped",
      stopReason: "worker_unavailable",
    });
    // The message written into the abandoned attempt's window is NOT swept up
    // with it — it was never that worker's, and the person still means it.
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
    // So it is what runs next, on its own terms rather than steered into a
    // turn that no longer exists.
    const second = store.claims.claimTurn("session_one", "worker_two")!;
    expect(second.runId).toBe("run_typed");
    store.turnLifecycle.markRunning("session_one", "run_typed", second.claim!.token);
    expect(store.worker.steerForWorker("worker_two")).toEqual([]);
  });

  test("a claim written before the watermark existed promotes nothing", () => {
    // Forward courtesy for a queue.json on disk from an older engine: absent
    // means "the behaviour this claim was written under", never "promote all".
    const { store, root: stateRoot } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const claim = store.claims.claimTurn("session_one", "worker_one")!;
    store.intake.submitTurn("session_one", { runId: "run_typed", input: "Hello?" });

    editDocument(store, stateRoot, "queue.json", (queue) => {
      for (const turn of queue.turns) if (turn.claim) delete turn.claim.sequence;
    });

    store.turnLifecycle.markRunning("session_one", "run_live", claim.claim!.token);
    expect(store.queries.turns("session_one").find((turn) => turn.runId === "run_typed")!.state).toBe("queued");
  });
});

describe("an agent's message is attributed, never the person's", () => {
  const pair = () => {
    const { store } = readyStore();
    store.lifecycle.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    return store;
  };

  test("sessions_send from inside a turn stamps the proven sender; a stale claim is refused", () => {
    const store = pair();
    store.intake.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const claimed = store.claims.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    // Not yet running: the proof is not live, and a message cannot be
    // attributed to a turn that has not started.
    expect(() => store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_early", input: "go" }, { sessionId: "session_one", runId: "run_host", claimToken: token })).toThrow(/not running/);
    store.turnLifecycle.markRunning("session_one", "run_host", token);

    const { turn } = store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_sent", input: "please do X" }, { sessionId: "session_one", runId: "run_host", claimToken: token });
    expect(turn).toMatchObject({ origin: "session", sender: { sessionId: "session_one" }, state: "queued", input: "please do X" });
    expect(turn.wakeReason).toBeUndefined();
    expect(store.queries.readEvents("session_two").filter((event) => event.type === "turn.accepted").at(-1)).toMatchObject({
      type: "turn.accepted",
      turn: { origin: "session", sender: { sessionId: "session_one" } },
    });

    // A forged proof — wrong token — is refused rather than attributed.
    expect(() => store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_forged", input: "as you" }, { sessionId: "session_one", runId: "run_host", claimToken: "x".repeat(32) })).toThrow(EngineStateError);
    // And a proof naming a session that does not exist.
    expect(() => store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_ghost", input: "boo" }, { sessionId: "session_nope", runId: "run_host", claimToken: token })).toThrow(EngineStateError);
  });

  test("a send from a turn that ENDED is refused with the session's live turn named, so a retry has somewhere to go (#297)", () => {
    // A send carrying a settled turn's claim is still refused (it proves no live sender),
    // but the refusal names the turn this session is running, which a retry is proven by.
    const store = pair();
    store.intake.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const first = store.claims.claimTurn("session_one", "worker_one")!;
    const firstToken = first.claim!.token;
    store.turnLifecycle.markRunning("session_one", "run_host", firstToken);
    store.turnLifecycle.completeTurn("session_one", "run_host", firstToken, { text: "handed out eight tasks" });

    // NO LIVE TURN: retrying would be the same refusal, so it says so instead
    // of pointing at a turn that does not exist.
    const orphaned = () =>
      store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_a", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: firstToken });
    expect(orphaned).toThrow(/already settled \(completed\)/);
    expect(orphaned).toThrow(/no live turn to send from/);

    // A FOREIGN TOKEN AGAINST THE SAME SETTLED TURN keeps the flat refusal:
    // the longer answer is for a session's own stale claim, never a hint
    // offered to whoever guessed a runId.
    expect(() =>
      store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_b", input: "as you" }, { sessionId: "session_one", runId: "run_host", claimToken: "x".repeat(32) }),
    ).toThrow(/not running under this worker claim/);

    // The CLI opens a turn of its own — now there is one to name.
    const provider = store.claims.openProviderTurn("session_one", { workerId: "worker_one", input: "Background task completed.", reason: { kind: "unknown" } });
    expect(() =>
      store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_c", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: firstToken }),
    ).toThrow(new RegExp(`live turn is ${provider.runId}`));

    // And proven by THAT turn's claim the send lands, attributed to the
    // session and sourced to the turn that actually sent it.
    const { turn } = store.intake.submitAgentTurn(
      "session_two",
      { intent: "task", runId: "run_d", input: "your brief" },
      { sessionId: "session_one", runId: provider.runId, claimToken: provider.claim!.token },
    );
    expect(turn).toMatchObject({ sender: { sessionId: "session_one" }, agentSourceRunId: provider.runId });
  });

  test("a restart retires the sender's claim, and the refusal says the turn was stopped rather than blaming the token (#297)", () => {
    // A restart deletes every claim, so a worker that outlived the engine holds a token that
    // matches nothing; the refusal must say restart, not claim mix-up.
    const stateRoot = root();
    const store = new EngineStore(stateRoot, () => 100);
    store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
    store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
    store.lifecycle.createSession({ id: "session_two", projectId: "project_one" });
    store.intake.submitTurn("session_one", { runId: "run_host", input: "orchestrate" });
    const claimed = store.claims.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    store.turnLifecycle.markRunning("session_one", "run_host", token);

    const rebooted = new EngineStore(stateRoot, () => 200);
    expect(rebooted.recovery.recover().stopped).toContain("run_host");
    const host = rebooted.queries.turns("session_one").find((turn) => turn.runId === "run_host")!;
    expect(host).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
    expect(host.claim).toBeUndefined();

    const stale = () =>
      rebooted.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_late", input: "your brief" }, { sessionId: "session_one", runId: "run_host", claimToken: token });
    expect(stale).toThrow(/was stopped \(engine_restart\)/);
    expect(stale).toThrow(/no live turn to send from/);
  });

  test("without proof it is still an agent's — unattributed, never a human bubble", () => {
    const store = pair();
    const { turn } = store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_socket", input: "from a chat client" });
    expect(turn.origin).toBe("session");
    expect(turn.sender).toEqual({});
    expect(turn.wakeReason).toBeUndefined();
  });

  test("the provenance rule: session origin needs exactly one of wakeReason or sender; a plain turn takes neither", () => {
    const store = pair();
    expect(() => store.intake.submitTurn("session_two", { runId: "r1", input: "x", origin: "session" })).toThrow(/exactly one/);
    expect(() => store.intake.submitTurn("session_two", { runId: "r2", input: "x", sender: { sessionId: "session_one" } })).toThrow(/exactly one/);
    expect(() =>
      store.intake.submitTurn("session_two", { runId: "r3", input: "x", origin: "session", sender: {}, wakeReason: { kind: "turn_completed", sessionId: "session_one" } }),
    ).toThrow(/exactly one/);
    expect(store.intake.submitTurn("session_two", { runId: "r4", input: "x" }).turn.origin).toBeUndefined();
  });

  test("an agent's message steered into a running turn carries its sender on the heartbeat; its turn's ending still wakes subscribers", () => {
    const store = pair();
    store.intake.submitTurn("session_two", { runId: "run_live", input: "working" });
    const live = store.claims.claimTurn("session_two", "worker_one")!;
    store.turnLifecycle.markRunning("session_two", "run_live", live.claim!.token);

    const steered = store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_steer", input: "also this" });
    expect(steered.turn.state).toBe("steering");
    const [delivery] = store.worker.steerForWorker("worker_one");
    expect(delivery).toMatchObject({ steerRunId: "run_steer", text: "also this", sender: {} });
    // A person's steer carries no sender at all.
    store.intake.submitTurn("session_two", { runId: "run_human", input: "and me" });
    expect(store.worker.steerForWorker("worker_one").find((each) => each.steerRunId === "run_human")?.sender).toBeUndefined();

    // A direct agent message is real work: when ITS turn ends, a subscriber
    // hears about it. Only a wake's own ending is silent.
    store.turnLifecycle.completeTurn("session_two", "run_live", live.claim!.token, { text: "done" });
    // The two undelivered steers went back to queued; drop them so the next
    // claim is the direct message below.
    store.turnLifecycle.stopTurn("session_two", "run_steer");
    store.turnLifecycle.stopTurn("session_two", "run_human");
    store.subscriptions.subscribe("session_one", { targetSessionId: "session_two", events: ["turn_completed"] });
    const direct = store.intake.submitAgentTurn("session_two", { intent: "task", runId: "run_direct", input: "next job" });
    expect(direct.turn.state).toBe("queued");
    const claimedDirect = store.claims.claimTurn("session_two", "worker_one")!;
    store.turnLifecycle.markRunning("session_two", "run_direct", claimedDirect.claim!.token);
    store.turnLifecycle.completeTurn("session_two", "run_direct", claimedDirect.claim!.token, { text: "finished the job" });
    const wake = store.queries.turns("session_one").find((turn) => turn.wakeReason);
    expect(wake?.wakeReason).toMatchObject({ kind: "turn_completed", runId: "run_direct" });
  });
});

test("a per-turn selection may be an effort alone", () => {
  const { store } = readyStore();
  const session = store.records.get("session_one");
  const { turn } = store.intake.submitTurn("session_one", { runId: "run_one", input: "hi", model: { effort: "low" } });
  expect(turn.model).toEqual({ instanceId: session.providerInstanceId, effort: "low" });
});
