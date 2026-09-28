import { afterEach, describe, expect, test } from "bun:test";
import type { EngineStore } from "../../../state";
import { cleanUp, call, capabilityOver, engine, wall } from "./test-helpers";
import { waitForDelegation } from "./wait";

afterEach(cleanUp);

function running(store: EngineStore, sessionId: string, runId: string): string {
  const token = store.claims.claimTurn(sessionId, `worker_${runId}`)!.claim!.token;
  store.turnLifecycle.markRunning(sessionId, runId, token);
  return token;
}

function orchestration() {
  const { store, projectId } = engine();
  const host = store.lifecycle.createSession({ projectId, title: "orchestrator" });
  const child = store.lifecycle.createSession({ projectId, title: "builder" });
  store.intake.submitTurn(host.id, { runId: "run_orchestrating", input: "orchestrate" });
  const hostToken = running(store, host.id, "run_orchestrating");
  const endTurn = () => store.turnLifecycle.completeTurn(host.id, "run_orchestrating", hostToken, { text: "done" });
  store.intake.submitAgentTurn(child.id, { runId: "run_task", input: "port the parser", intent: "task" }, { sessionId: host.id, runId: "run_orchestrating", claimToken: hostToken });
  const childToken = running(store, child.id, "run_task");
  const reply = (intent: "result" | "blocker", input: string) =>
    void store.intake.submitAgentTurn(host.id, { runId: `run_${intent}`, input, intent }, { sessionId: child.id, runId: "run_task", claimToken: childToken });
  let clock = 0;
  const after = (act: () => void) => ({ now: () => clock, pause: async (ms: number) => void ((clock += ms), act()) });
  return { store, host, child, capability: capabilityOver(store, { sessionId: host.id }), reply, after, elapsed: () => clock, endTurn };
}

describe("waiting on a delegated task", () => {
  test("the child's result comes back in the same call, and no wake follows it", async () => {
    const { store, host, child, capability, reply, after, endTurn } = orchestration();
    const turnsBefore = store.queries.turns(host.id).length;
    const waited = await waitForDelegation(capability, child.id, 60, after(() => reply("result", "Parser ported; 12 tests pass.")));

    expect(waited).toMatchObject({ done: true, member: { sessionId: child.id, outcome: "result" } });
    expect("done" in waited && waited.member.excerpt).toContain("Parser ported; 12 tests pass.");
    expect(store.subscriptions.cohortsFor(host.id)).toEqual([]);
    const runnable = () => store.queries.turns(host.id).filter((turn) => turn.agentDelivery !== "passive");
    expect(runnable()).toHaveLength(turnsBefore);
    endTurn();
    expect(runnable().filter((turn) => turn.state !== "completed")).toEqual([]);
  });

  test("a timeout cancels nothing and leaves the caller subscribed", async () => {
    const { store, host, child, capability, after, elapsed } = orchestration();
    const waited = await waitForDelegation(capability, child.id, 5, after(() => undefined));

    expect(waited).toMatchObject({ timedOut: true });
    expect(elapsed()).toBe(5_000);
    const [cohort] = store.subscriptions.cohortsFor(host.id);
    expect(cohort!.id).toBe("timedOut" in waited ? waited.cohortId : "");
    expect(cohort!.members.map((member) => member.sessionId)).toEqual([child.id]);
  });

  test("a blocker ends the wait at once so the caller can answer it", async () => {
    const { child, capability, reply, after, elapsed } = orchestration();
    const waited = await waitForDelegation(capability, child.id, 60, after(() => reply("blocker", "Which parser version?")));
    expect(waited).toMatchObject({ blocked: true });
    expect(elapsed()).toBe(1_000);
  });
});

describe("the wait parameter", () => {
  test("sessions_send takes wait only with intent task", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "orchestrator" });
    const child = store.lifecycle.createSession({ projectId, title: "builder" });
    const refused = await call(wall(store, { sessionId: host.id }), "sessions_send", { sessionId: child.id, input: "fyi", wait: 30 });
    expect(refused.isError).toBe(true);
    expect(store.queries.turns(child.id)).toEqual([]);
  });

  test("sessions_create refuses wait without a task, before creating anything", async () => {
    const { store, projectId } = engine();
    const before = store.records.all().length;
    const refused = await call(wall(store), "sessions_create", { projectId, envMode: "local", wait: 30 });
    expect(refused.isError).toBe(true);
    expect(store.records.all()).toHaveLength(before);
  });

  test("both tools advertise a bounded wait", () => {
    const tools = wall(engine().store);
    for (const name of ["sessions_create", "sessions_send"]) {
      const wait = tools.get(name)!.shape.wait as { safeParse: (value: unknown) => { success: boolean } };
      expect(wait.safeParse(600).success).toBe(true);
      expect(wait.safeParse(601).success).toBe(false);
    }
  });
});
