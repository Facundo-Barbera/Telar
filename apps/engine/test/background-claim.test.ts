/**
 * #891 — A TASK THE ENGINE KEEPS ALIVE PAST TURN END ALWAYS HAS A CLAIM ITS
 * PERMISSION REQUESTS ARE HONOURED UNDER.
 *
 * The end-to-end half of the invariant, against a real daemon, a real store and
 * a real worker; `driver.test.ts` owns the Claude driver's side of it. What
 * this file pins is the seam between them — that the engine really does keep
 * the row alive, really does refuse the settled turn's claim, and really does
 * open a turn for the work when the driver asks for one.
 *
 * THE CONTRADICTION IT CLOSES. `completeTurn` calls `closeOrphanedTasks` with
 * `includeBackground: false` on purpose: outliving its turn is what
 * backgrounding means. The same call settles the only claim that row's requests
 * could be made under. Two deliberate decisions, opposite in effect, and the
 * gap between them is where sixteen sub-agent transcripts died — the child's
 * every mutating call answered "turn has already settled (completed); this
 * report arrived after the turn ended", which a model reads as the person
 * saying no.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { DriverRun, DriverSessionHooks, ProviderTurnBinding, TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";
import { stubModels } from "./stub-models";
import { until } from "./wait";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** What the turn left behind: the settled claim's gate, and the session door
 *  the driver opens a new claim through. */
type Dispatched = {
  /** The gate bound to the turn that has now settled — the dead claim. */
  settledGate: NonNullable<DriverRun["onRequest"]>;
  session: DriverSessionHooks;
};

/**
 * A driver that dispatches ONE backgrounded agent and answers, the shape #891
 * was filed on. It keeps nothing alive itself — the point is what the ENGINE
 * does with the row and the claim after `run` returns.
 */
function dispatchingDriver(): { driver: TurnDriver; dispatched: Promise<Dispatched> } {
  let announce!: (value: Dispatched) => void;
  const dispatched = new Promise<Dispatched>((resolve) => { announce = resolve; });
  const driver: TurnDriver = {
    run: async ({ onObservations, onRequest, session }) => {
      await onObservations([
        {
          kind: "task.started",
          task: {
            id: "task_toolu_agent",
            kind: "agent",
            // THE FIELD THAT MAKES IT OUTLIVE THE TURN. `isBackgroundWork`
            // reads `kind === "background" || backgrounded === true`.
            backgrounded: true,
            state: "running",
            title: "build the thing",
            providerTaskId: "sdk_agent",
          },
        },
      ]);
      announce({ settledGate: onRequest!, session: session! });
      return { text: "dispatched; it will report back" };
    },
  };
  return { driver, dispatched };
}

async function engine(): Promise<{ daemon: EngineDaemon; client: EngineClient }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bgclaim-"));
  roots.push(directory);
  const daemon = await startEngine({ models: stubModels, engineRoot: directory, workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  // The default runtime mode is `auto`, so a `tool_call` resolves by policy
  // rather than parking — what a detached builder's session actually is.
  await client.createSession({ id: "session_one", projectId: "project_one" });
  return { daemon, client };
}

async function turnThatDispatches(): Promise<{ client: EngineClient; dispatched: Promise<Dispatched>; parentRunId: string }> {
  const { client } = await engine();
  const { driver, dispatched } = dispatchingDriver();
  const worker = new EngineWorker({ client, workerId: "worker_bg", driver, pollMs: 10, onDiagnostic: () => {} });
  workers.push(worker);
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_parent", input: "dispatch a builder" });
  await until("the parent turn to settle", async () => {
    const turns = (await client.session("session_one")).turns;
    return turns.some((turn) => turn.runId === "run_parent" && turn.state === "completed");
  });
  return { client, dispatched, parentRunId: "run_parent" };
}

test("the engine keeps the row alive and settles its claim — and the turn's own gate is then refused, in words the child can act on", async () => {
  const { client, dispatched } = await turnThatDispatches();
  const { settledGate } = await dispatched;

  // BOTH HALVES OF THE CONTRADICTION, in one snapshot: the task is alive…
  const snapshot = await client.session("session_one");
  expect(snapshot.tasks.map((task) => [task.id, task.state])).toEqual([["task_toolu_agent", "running"]]);
  // …and the turn it was launched from has settled.
  expect(snapshot.turns.find((turn) => turn.runId === "run_parent")?.state).toBe("completed");

  /**
   * THE FLOOR (#891 fix 1, #835 remedy 2). Reaching the dead claim is still
   * possible — another driver, a genuine race — and when it happens the child
   * is told what actually went wrong. The engine's own sentence is written for
   * a daemon log; it rides along in parentheses rather than being the whole
   * message, because a model that reads plumbing as a person's "no" reports
   * back that the human declined (#28).
   */
  const refusal = await settledGate({
    kind: "tool_call",
    detail: { kind: "command_execution", command: { command: "rm -rf build" } },
    toolUseId: "toolu_child",
  }).then(() => undefined, (error: unknown) => error as Error);
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal!.message).toContain("the turn it was made under has ended");
  expect(refusal!.message).toContain("nobody declined it");
  expect(refusal!.message).toContain("turn has already settled");
});

test("a claim opened for the live task honours its request, under a turn of its own", async () => {
  /**
   * THE FIX. The driver asks the session door for a turn — the same
   * `onProviderTurn` a wake-up uses — and the request rides the routes every
   * other request rides: a real claim, a real `request.opened` on the journal,
   * a real decision.
   */
  const { client, dispatched } = await turnThatDispatches();
  const { session } = await dispatched;

  const binding = (await session.onProviderTurn({
    input: "",
    reason: { kind: "background_task", taskId: "task_toolu_agent" },
  })) as ProviderTurnBinding;
  expect(binding).toBeDefined();
  expect(binding.runId).not.toBe("run_parent");

  const outcome = await binding.onRequest!({
    kind: "tool_call",
    detail: { kind: "command_execution", command: { command: "bun test" } },
    toolUseId: "toolu_child",
  });
  expect(outcome).toEqual({ decision: "accept" });

  // It is the session's own state, not a side channel: the request is filed
  // under the new turn, and the turn says why it exists.
  const during = await client.session("session_one");
  const opened = during.requests.find((request) => request.id === "req_toolu_child");
  expect(opened?.runId).toBe(binding.runId);
  expect(opened?.state).toBe("resolved");
  expect(during.turns.find((turn) => turn.runId === binding.runId)).toMatchObject({
    origin: "provider",
    state: "running",
    providerReason: { kind: "background_task", taskId: "task_toolu_agent" },
  });

  await binding.close({ text: "Decided a tool call for background work still running after its turn ended." });
  await until("the background claim's turn to settle", async () => {
    const turns = (await client.session("session_one")).turns;
    return turns.find((turn) => turn.runId === binding.runId)?.state === "completed";
  });
  // And the task it was opened for is still running — deciding for it did not
  // end it.
  expect((await client.session("session_one")).tasks[0]?.state).toBe("running");
});

test("the person's next message tells the claim it is wanted, and runs once the claim lets go", async () => {
  /**
   * WHY A CLAIM HELD FOR THE TASK'S WHOLE LIFE IS NOT A TURN THAT NEVER
   * SETTLES (#912). The driver holds one claim while any background task is
   * alive, so one stretch of work is one turn rather than a row per burst. One
   * live turn per session is still the invariant every sweep relies on, so the
   * person's message must not sit behind a sub-agent for an hour: it reaches
   * the claim as a steer, the worker aborts the binding's `wanted` signal, and
   * the driver gives the session up — which is what this proves.
   */
  const { client, dispatched } = await turnThatDispatches();
  const { session } = await dispatched;
  const binding = (await session.onProviderTurn({ input: "", reason: { kind: "background_task" } })) as ProviderTurnBinding;
  expect(binding.wanted?.aborted).toBe(false);

  await client.submitTurn("session_one", { runId: "run_person", input: "how is it going?" });
  /**
   * NOT REFUSED, AND NOT DISPATCHED OVER THE LIVE CLAIM. A message sent while
   * any turn is live becomes a STEER on it — and this particular live turn has
   * no model reading its mailbox, so the steer is never delivered and
   * `completeTurn`'s `requeueUndeliveredSteers` puts it back in the queue.
   */
  const waiting = (await client.session("session_one")).turns.find((turn) => turn.runId === "run_person");
  expect(waiting?.state).toBe("steering");
  await until("the worker to tell the claim it is wanted", () => binding.wanted?.aborted === true);

  await binding.close({ text: "done" });
  await until("the person's message to run once the claim is given up", async () => {
    const turn = (await client.session("session_one")).turns.find((candidate) => candidate.runId === "run_person");
    return turn?.state === "completed";
  });
});
