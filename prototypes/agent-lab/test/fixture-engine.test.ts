/**
 * The fixture engine's own behaviour — the part every scenario's evidence rests
 * on, so it is checked directly rather than only through an agent.
 */
import { describe, expect, test } from "bun:test";
import { FixtureEngine } from "../src/harness/fixtures/engine";
import { AGENT_SUBSCRIBER_ID } from "../src/harness/fixtures/capabilities";

describe("fixture engine", () => {
  test("a delegated task runs, completes, and wakes the subscriber", async () => {
    const engine = new FixtureEngine({ workerDelayMs: 5 });
    const worker = engine.createSession({ projectId: "prj_lab", title: "Worker", envMode: "worktree" });
    engine.subscribe(AGENT_SUBSCRIBER_ID, { targetSessionId: worker.id, events: ["turn_completed"], once: true });
    engine.send(worker.id, { runId: "run_a", input: "do the thing", intent: "task" });
    await engine.drain();

    expect(engine.turns(worker.id)[0].state).toBe("completed");
    expect(engine.wakes).toHaveLength(1);
    expect(engine.wakes[0]).toMatchObject({ kind: "turn_completed", targetSessionId: worker.id, runId: "run_a" });
    engine.close();
  });

  test("failOnce fails the first run and lets the second through", async () => {
    const engine = new FixtureEngine({ workerDelayMs: 5, failOnce: true });
    const worker = engine.createSession({ projectId: "prj_lab", title: "Worker", envMode: "worktree" });
    engine.send(worker.id, { runId: "run_a", input: "first", intent: "task" });
    await engine.drain();
    expect(engine.turns(worker.id)[0].state).toBe("failed");

    engine.send(worker.id, { runId: "run_b", input: "second", intent: "task" });
    await engine.drain();
    expect(engine.turns(worker.id)[1].state).toBe("completed");
    expect(engine.counts.workerFailures).toBe(1);
    engine.close();
  });

  test("a resubmitted runId replays rather than queueing a second turn", () => {
    const engine = new FixtureEngine({ workerDelayMs: 5 });
    const worker = engine.createSession({ projectId: "prj_lab", envMode: "local" });
    const first = engine.send(worker.id, { runId: "run_a", input: "x", intent: "task" });
    const again = engine.send(worker.id, { runId: "run_a", input: "x", intent: "task" });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(engine.counts.sendCalls).toBe(2);
    expect(engine.counts.sendsAccepted).toBe(1);
    expect(engine.turns(worker.id)).toHaveLength(1);
    engine.close();
  });

  test("a report is passive: no worker starts and nothing is woken", async () => {
    const engine = new FixtureEngine({ workerDelayMs: 5 });
    const worker = engine.createSession({ projectId: "prj_lab", envMode: "local" });
    engine.subscribe(AGENT_SUBSCRIBER_ID, { targetSessionId: worker.id });
    engine.send(worker.id, { runId: "run_a", input: "fyi", intent: "report" });
    await engine.drain();
    expect(engine.counts.workerRuns).toBe(0);
    expect(engine.wakes).toHaveLength(0);
    engine.close();
  });

  test("close clears every timer, so nothing outlives the test", async () => {
    const engine = new FixtureEngine({ workerDelayMs: 10_000 });
    const worker = engine.createSession({ projectId: "prj_lab", envMode: "local" });
    engine.send(worker.id, { runId: "run_a", input: "slow", intent: "task" });
    engine.close();
    expect(engine.counts.workerRuns).toBe(0);
  });
});
