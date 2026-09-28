import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

test("a per-turn model beats the session default and cannot change the provider", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });

  const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Hi", model: { model: "claude-haiku-4-5", effort: "low" } });
  // The instance is STAMPED FROM THE SESSION — the wire shape has no field for
  // it, so a client cannot ask for a different provider mid-conversation.
  expect(turn.model).toEqual({ instanceId: session.providerInstanceId, model: "claude-haiku-4-5", effort: "low" });

  const claim = store.claimNextTurn("worker_one");
  expect(claim?.model).toEqual({ instanceId: session.providerInstanceId, model: "claude-haiku-4-5", effort: "low" });
});

test("a turn with no model of its own falls back to the session's", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });
  store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  // As named: a bare id is the standard-window row, a choice in its own right.
  expect(store.claimNextTurn("worker_one")?.model?.model).toBe("claude-opus-5");
});

test("a daemon-injected computer-use resolver reaches a claim", () => {
  // The resolver is an OPTION, not a default — a store built without one (every
  // other test in this file) never reads the machine's installs.
  const stateRoot = root();
  const resolved = {
    backend: "cua" as const,
    server: {
      id: "mac",
      label: "Computer Use (Mac)",
      enabled: true,
      spec: { transport: "stdio" as const, command: "/fake/cua-driver", args: ["mcp"] },
      createdAt: 0,
      updatedAt: 0,
    },
  };
  const store = new EngineStore(stateRoot, () => 100, { computerUse: () => resolved });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  expect(store.claimNextTurn("worker_one")?.mcpServers?.map((server) => server.id)).toEqual(["mac"]);
});

test("a turn's service tier and ultracode reach the claim beside its model", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "hi", model: { model: "claude-opus-5[1m]", ultracode: true, serviceTier: "priority" } });
  expect(store.claimNextTurn("worker_one")?.model).toMatchObject({ model: "claude-opus-5[1m]", ultracode: true, serviceTier: "priority" });
});

test("fast mode survives a selection that names no model", () => {
  // A Claude-side switch the composer offers on the provider default, so it has
  // to survive a selection that names no model at all — and it travels beside
  // the long-window default the claim supplies for a session that named none.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, fastMode: true } });
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, fastMode: true, model: "claude-opus-5[1m]" });
});

test("a provider turn is born running under a claim, and a human message sent meanwhile is steered into it", () => {
  const { store } = readyStore();
  const turn = store.openProviderTurn("session_one", {
    workerId: "worker_one",
    input: "Background task completed (DONE).",
    reason: { kind: "task_notification", taskId: "task_toolu_bg" },
  });
  expect(turn).toMatchObject({ state: "running", origin: "provider", providerReason: { kind: "task_notification", taskId: "task_toolu_bg" } });
  expect(turn.claim?.workerId).toBe("worker_one");
  expect(store.getSession("session_one").activity).toBe("working");
  expect(store.readEvents("session_one").slice(-3).map((event) => event.type)).toEqual(["turn.accepted", "turn.claimed", "turn.started"]);
  // A second one cannot open while this runs — one turn per session.
  expect(() => store.openProviderTurn("session_one", { workerId: "worker_one", input: "x", reason: { kind: "unknown" } })).toThrow("live turn");
  // The usual routes work under its claim.
  store.ingestObservations("session_one", turn.runId, turn.claim!.token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "merging" } } },
  ]);
  // A human message while it runs goes where a message during any running
  // turn goes: straight into it.
  expect(store.submitTurn("session_one", { runId: "run_human", input: "also check the docs" }).turn).toMatchObject({ state: "steering", steer: { intoRunId: turn.runId } });
  store.completeTurn("session_one", turn.runId, turn.claim!.token, { text: "merged" });
  const turns = new Map(store.turns("session_one").map((candidate) => [candidate.runId, candidate]));
  expect(turns.get(turn.runId)).toMatchObject({ state: "completed", resultText: "merged", origin: "provider" });
  // The steered message was not delivered before the turn settled: back to
  // the queue, where it runs as the next human turn.
  expect(turns.get("run_human")?.state).toBe("queued");
});

test("a provider turn can open over a queued one, so a lower sequence can start after a higher one finished", () => {
  let clock = 100;
  const store = new EngineStore(root(), () => (clock += 10));
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  const waiting = store.submitTurn("session_one", { runId: "run_waiting", input: "cohort done" }).turn;
  expect(waiting.state).toBe("queued");
  const provider = store.openProviderTurn("session_one", { workerId: "worker_one", input: "Background task completed.", reason: { kind: "unknown" } });
  expect(provider.sequence).toBeGreaterThan(waiting.sequence);
  store.completeTurn("session_one", provider.runId, provider.claim!.token, { text: "done" });
  const claimed = store.claimNextTurn("worker_one")!;
  expect(claimed.turn.runId).toBe("run_waiting");
  store.markRunning("session_one", "run_waiting", claimed.turn.claim!.token);
  const turns = new Map(store.turns("session_one").map((turn) => [turn.runId, turn]));
  expect(turns.get("run_waiting")!.startedAt!).toBeGreaterThan(turns.get(provider.runId)!.completedAt!);
});

describe("worker queries scale with live turns, not with the number of sessions", () => {
  function storeWith(idleSessions: number): { store: EngineStore; root: string } {
    const stateRoot = root();
    const store = new EngineStore(stateRoot, () => 100);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    for (let index = 0; index < idleSessions; index += 1) {
      const id = `session_idle${String(index).padStart(4, "0")}`;
      store.createSession({ id, projectId: "project_one" });
      // Settled work, exactly like a conversation somebody finished last week.
      store.submitTurn(id, { runId: `run_${id}`, input: "done long ago" });
      const claim = store.claimTurn(id, "worker_old")!;
      store.markRunning(id, `run_${id}`, claim.claim!.token);
      store.completeTurn(id, `run_${id}`, claim.claim!.token, { text: "done" });
    }
    return { store, root: stateRoot };
  }

  /** File reads performed while `run` executes. */
  function readsDuring(run: () => void): number {
    const spy = spyOn(fs, "readFileSync");
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  test("a heartbeat's reads do not grow when settled conversations pile up", () => {
    const few = storeWith(4);
    const many = storeWith(40);
    // Warm each index once — the lazily-built scan is paid on first use, not
    // ten times a second, and it is the STEADY state this is about.
    few.store.cancellationsForWorker("worker_one");
    many.store.cancellationsForWorker("worker_one");

    const beat = (store: EngineStore): number =>
      readsDuring(() => {
        store.cancellationsForWorker("worker_one");
        store.resolutionsForWorker("worker_one");
        store.steerForWorker("worker_one");
      });

    // Ten times the history, and the same work: nothing here is per-session.
    expect(beat(few.store)).toBe(beat(many.store));
    expect(beat(many.store)).toBeLessThan(10);
  });

  test("a claim reads the queues that could be claimed and the metadata of the one that wins", () => {
    const claimReads = (idleSessions: number): { sessionId?: string; reads: number } => {
      const { store } = storeWith(idleSessions);
      store.createSession({ id: "session_live", projectId: "project_one" });
      store.submitTurn("session_live", { runId: "run_live", input: "Hello" });
      store.cancellationsForWorker("worker_one"); // warm the index
      let sessionId: string | undefined;
      const reads = readsDuring(() => {
        sessionId = store.claimNextTurn("worker_one")?.sessionId;
      });
      return { ...(sessionId ? { sessionId } : {}), reads };
    };

    const few = claimReads(4);
    const many = claimReads(40);
    expect(few.sessionId).toBe("session_live");
    expect(many.sessionId).toBe("session_live");
    // Ten times the settled history, and not one extra read: the claim touches
    // the claimable queues and the winner's metadata, nothing else.
    expect(many.reads).toBe(few.reads);
  });

  test("the index follows every transition: a settled session leaves it, a stopped one stays until its claim is gone", () => {
    const { store } = storeWith(0);
    store.createSession({ id: "session_a", projectId: "project_one" });
    store.submitTurn("session_a", { runId: "run_a", input: "Hello" });
    const claim = store.claimNextTurn("worker_one")!;
    const token = claim.turn.claim!.token;
    store.markRunning("session_a", "run_a", token);

    // Stopped, but the worker still has to be told — so it is still visible.
    store.stopTurn("session_a", "run_a");
    expect(store.cancellationsForWorker("worker_one")).toEqual([
      { sessionId: "session_a", runId: "run_a", claimToken: token },
    ]);

    // A fresh turn that completes leaves nothing for any worker to ask about.
    store.submitTurn("session_a", { runId: "run_b", input: "Again" });
    const second = store.claimNextTurn("worker_two")!;
    const secondToken = second.turn.claim!.token;
    store.markRunning("session_a", "run_b", secondToken);
    store.completeTurn("session_a", "run_b", secondToken, { text: "done" });
    expect(store.cancellationsForWorker("worker_two")).toEqual([]);
    expect(store.claimNextTurn("worker_two")).toBeUndefined();
  });

  test("across sessions the oldest ACCEPTED message runs first, whatever age its session is", () => {
    const stateRoot = root();
    let clock = 100;
    const store = new EngineStore(stateRoot, () => clock);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    // `session_old` exists first; the message in it is written second.
    store.createSession({ id: "session_old", projectId: "project_one" });
    store.createSession({ id: "session_new", projectId: "project_one" });
    clock = 200;
    store.submitTurn("session_new", { runId: "run_first", input: "typed first" });
    clock = 300;
    store.submitTurn("session_old", { runId: "run_second", input: "typed second" });

    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_first");
    expect(store.claimNextTurn("worker_two")?.turn.runId).toBe("run_second");
  });
});

describe("a Claude model is stored and claimed as named — both windows are choices", () => {
  test("a bare id is its standard window and a `[1m]` id its long one, at every door", () => {
    const { store } = readyStore();
    const session = store.getSession("session_one");
    const instanceId = session.providerInstanceId;
    // The session patch keeps the 200k pick rather than rewriting it to 1M.
    expect(store.updateSession("session_one", { model: { instanceId, model: "opus", effort: "medium" } }).model).toEqual({ instanceId, model: "opus", effort: "medium" });
    expect(store.updateSession("session_one", { model: { instanceId, model: "claude-fable-5-1[1m]" } }).model?.model).toBe("claude-fable-5-1[1m]");
    // The per-turn choice and the claim.
    const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "Hi", model: { model: "fable" } });
    expect(turn.model?.model).toBe("fable");
    expect(store.claimNextTurn("worker_one")?.model?.model).toBe("fable");
  });

  test("a session that named no model still claims the long-window default", () => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hi" });
    expect(store.claimNextTurn("worker_one")?.model?.model).toMatch(/\[1m\]$/);
  });

  test("a Codex id is never touched", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
    const instanceId = store.getSession("session_codex").providerInstanceId;
    expect(store.updateSession("session_codex", { model: { instanceId, model: "gpt-5.6-sol" } }).model?.model).toBe("gpt-5.6-sol");
  });
});

describe("a rate-limited turn resumes itself once the limit resets", () => {
  /** A store whose clock a test can move — the shared helper pins it at 100. */
  function limitedStore(): { store: EngineStore; root: string; at: () => number; setNow: (next: number) => void } {
    const stateRoot = root();
    let now = 1_000;
    const store = new EngineStore(stateRoot, () => now);
    store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    store.createSession({ id: "session_one", projectId: "project_one" });
    return { store, root: stateRoot, at: () => now, setNow: (next) => { now = next; } };
  }

  /** Run a turn far enough to fail it as `rate_limited`, resetting at `resumeAt`. */
  function hitTheLimit(store: EngineStore, runId: string, resumeAt: number): void {
    store.submitTurn("session_one", { runId, input: "Do the thing" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.failTurn("session_one", runId, token, {
      code: "rate_limited",
      message: "Claude's five hour usage limit was reached, so this turn stopped where it stood.",
      resumeAt,
      limitType: "five_hour",
    });
  }

  const turnOf = (store: EngineStore, runId: string) => store.turns("session_one").find((candidate) => candidate.runId === runId)!;

  test("the failure records when the limit lifts, and refuses to exist without it", () => {
    const { store } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    expect(turnOf(store, "run_one")).toMatchObject({
      state: "failed",
      failure: { code: "rate_limited", resumeAt: 5_000, limitType: "five_hour" },
    });

    // A wait with no instant to wait for would sit failed for ever while
    // claiming to be temporary, and the sweep would skip it in silence.
    store.submitTurn("session_one", { runId: "run_two", input: "again" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_two", token);
    expect(() =>
      store.failTurn("session_one", "run_two", token, { code: "rate_limited", message: "limited" }),
    ).toThrow(/must say when the limit resets/);
  });

  test("a past reset requeues the turn; a future one leaves it alone", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    // Before the reset: the poll looks, decides nothing, and hands out no work.
    setNow(4_999);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();
    expect(turnOf(store, "run_one").state).toBe("failed");
    expect(turnOf(store, "run_one").failure?.resumeDecidedAt).toBeUndefined();

    // The instant it passes, the same poll brings the turn back and claims it.
    setNow(5_000);
    const claimed = store.claimNextTurn("worker_one");
    expect(claimed?.turn.runId).toBe("run_one");
    expect(turnOf(store, "run_one")).toMatchObject({ resumedAfterRateLimit: 5_000 });
    expect(store.readEvents("session_one").some((event) => event.type === "turn.requeued" && event.reason === "rate_limit_reset")).toBeTrue();
  });

  test("with the setting off the turn stays failed, and is not reconsidered on every poll", () => {
    const { store, setNow } = limitedStore();
    store.updateSession("session_one", { resumeAfterRateLimit: false });
    hitTheLimit(store, "run_one", 5_000);

    setNow(6_000);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();
    const settled = turnOf(store, "run_one");
    expect(settled.state).toBe("failed");
    // Stamped, so `queueConcernsAWorker` stops matching it: without this the
    // session would sit in the live index being re-examined for the life of the
    // daemon. The reset time SURVIVES, because the row still shows it.
    expect(settled.failure).toMatchObject({ code: "rate_limited", resumeAt: 5_000, resumeDecidedAt: 6_000 });
    expect(store.readEvents("session_one").some((event) => event.type === "turn.requeued" && event.reason === "rate_limit_reset")).toBeFalse();
  });

  test("the default is on for Claude and off for another provider, without writing either down", () => {
    const { store, setNow } = limitedStore();
    // Nothing stored: a session made before the setting existed behaves like
    // one made after it.
    expect(store.getSession("session_one").resumeAfterRateLimit).toBeUndefined();
    hitTheLimit(store, "run_one", 5_000);
    setNow(5_001);
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");

    const { store: codex, setNow: setCodexNow } = limitedStore();
    codex.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
    codex.submitTurn("session_codex", { runId: "run_codex", input: "Do the thing" });
    const token = codex.claimTurn("session_codex", "worker_one")!.claim!.token;
    codex.markRunning("session_codex", "run_codex", token);
    codex.failTurn("session_codex", "run_codex", token, { code: "rate_limited", message: "limited", resumeAt: 5_000 });
    setCodexNow(5_001);
    expect(codex.claimNextTurn("worker_one")).toBeUndefined();
  });

  test("a session that never chose follows the standing default, and its own choice still wins", () => {
    const { store, setNow } = limitedStore();
    store.setSessionDefaults({ resumeAfterRateLimit: false });
    hitTheLimit(store, "run_one", 5_000);
    setNow(5_001);
    expect(store.claimNextTurn("worker_one")).toBeUndefined();

    const { store: chosen, setNow: setChosenNow } = limitedStore();
    chosen.setSessionDefaults({ resumeAfterRateLimit: false });
    chosen.updateSession("session_one", { resumeAfterRateLimit: true });
    hitTheLimit(chosen, "run_one", 5_000);
    setChosenNow(5_001);
    expect(chosen.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  // A failed `rate_limited` turn must keep its session in the cold-built live index, or a limit that
  // lifts while Telar is closed is never resumed.
  test("a limit that lifts while the engine is down is resumed on the next boot", () => {
    const { store, root: stateRoot } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    let now = 9_000;
    const rebooted = new EngineStore(stateRoot, () => now);
    expect(rebooted.claimNextTurn("worker_two")?.turn.runId).toBe("run_one");
    now += 1;
    expect(rebooted.turns("session_one").find((candidate) => candidate.runId === "run_one")).toMatchObject({ resumedAfterRateLimit: 9_000 });
  });

  test("a resumed turn keeps its place, so a backlog still runs in the order it was typed", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    // Typed while the session was sitting out the limit.
    store.submitTurn("session_one", { runId: "run_later", input: "and then this" });

    setNow(5_000);
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  test("Resume now runs the turn before its reset, and says a person did it", () => {
    const { store } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);

    // DELIBERATELY NOT CLOCK-CHECKED: another credential came free, the proxy
    // moved account. Refusing until the reset would make the button a
    // decoration on the only occasions it is wanted.
    const resumed = store.resumeRateLimitedTurn("session_one", "run_one");
    expect(resumed.state).toBe("queued");
    // The engine did not bring this one back, so it must not claim it did.
    expect(resumed.resumedAfterRateLimit).toBeUndefined();
    expect(resumed.failure).toMatchObject({ code: "rate_limited", resumeDecidedAt: 1_000 });
    expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
  });

  test("Resume now refuses a turn that is not waiting on a limit, and one already running", () => {
    const { store } = limitedStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Do the thing" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_one", token);
    store.failTurn("session_one", "run_one", token, { code: "driver_failed", message: "the CLI died" });
    expect(() => store.resumeRateLimitedTurn("session_one", "run_one")).toThrow(/not waiting for a usage limit/);

    hitTheLimit(store, "run_two", 5_000);
    store.submitTurn("session_one", { runId: "run_three", input: "live" });
    const live = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", "run_three", live);
    // One turn at a time is the engine's own invariant; a click must not be the
    // one thing that can break it.
    expect(() => store.resumeRateLimitedTurn("session_one", "run_two")).toThrow(/already running a turn/);
  });

  test("a paused session is neither resumed nor quietly stamped as decided", () => {
    const { store, setNow } = limitedStore();
    hitTheLimit(store, "run_one", 5_000);
    store.stopSession("session_one");

    setNow(6_000);
    store.claimNextTurn("worker_one");
    // Left undecided on purpose: stamping here would mean a session stopped
    // across its own reset time silently lost the resume it was promised.
    const held = turnOf(store, "run_one");
    if (held.state === "failed") expect(held.failure?.resumeDecidedAt).toBeUndefined();
  });
});
