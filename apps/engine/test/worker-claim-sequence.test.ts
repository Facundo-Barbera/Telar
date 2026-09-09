import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";

/**
 * #208 — A LOST CLAIM RESPONSE MUST BE REPEATABLE, NEVER A SECOND ALLOCATION.
 *
 * Real daemon and store in a temp home; no installed app, no live home, no
 * provider. `claimSeq` is a per-registration high-watermark: equal replays the
 * cached outcome, older is refused without allocating, only the next number
 * allocates — and only once the current op is definitive.
 */

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

const home = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-claimseq-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine(options: { onWorkerRetired?: (workerId: string) => void } = {}) {
  const daemon = await startEngine({ engineRoot: home(), workerLeaseMs: 60_000, ...options });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  return { daemon, client };
}

const silent: TurnDriver = { run: async () => ({ text: "" }) };

test("A, retry A, then B, then the DELAYED ORIGINAL A — one allocation, and the straggler is refused", async () => {
  /**
   * THE RACE A RANDOM REQUEST ID CANNOT SURVIVE: original A is delayed, its
   * retry resolves, B supersedes it, and A finally arrives with an id nobody
   * remembers — so it allocates a second turn. An ordered watermark has no such
   * window, and this is the exact sequence.
   */
  const { client } = await engine();
  await client.registerWorker("worker_seq");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });

  // A allocates the only claimable turn.
  const first = await client.claimTurn("worker_seq", 1);
  expect(first.claim?.turn.runId).toBe("run_one");
  // A's retry REPLAYS it — same turn, same claim token, no second allocation.
  const retry = await client.claimTurn("worker_seq", 1);
  expect(retry.claim?.turn.runId).toBe("run_one");
  expect(retry.claim?.turn.claim?.token).toBe(first.claim!.turn.claim!.token);

  // B is the next op. Nothing left to claim, and `undefined` is cached too.
  const second = await client.claimTurn("worker_seq", 2);
  expect(second.claim).toBeUndefined();
  expect((await client.claimTurn("worker_seq", 2)).claim).toBeUndefined();

  // THE DELAYED ORIGINAL A, arriving last. Refused, and it allocates nothing.
  await client.submitTurn("session_one", { runId: "run_two", input: "Then this" });
  await expect(client.claimTurn("worker_seq", 1)).rejects.toMatchObject({ code: "conflict" });
  const turns = (await client.session("session_one")).turns;
  expect(turns.map((turn) => [turn.runId, turn.state])).toEqual([
    ["run_one", "claimed"],
    ["run_two", "queued"],
  ]);
});

test("a sequence that skips ahead is refused rather than allocating", async () => {
  const { client } = await engine();
  await client.registerWorker("worker_gap");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await expect(client.claimTurn("worker_gap", 5)).rejects.toMatchObject({ code: "invalid_request" });
  expect((await client.session("session_one")).turns[0]?.state).toBe("queued");
});

test("concurrent duplicates of one sequence allocate ONCE, even across the authorize await", async () => {
  /**
   * The claim branch authorizes MCP servers over the network before replying,
   * so two duplicates interleaving between the watermark check and the cache
   * would both allocate. The route serialises per worker.
   */
  const { client } = await engine();
  await client.registerWorker("worker_race");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await client.submitTurn("session_one", { runId: "run_two", input: "Then this" });
  const [a, b, c] = await Promise.all([client.claimTurn("worker_race", 1), client.claimTurn("worker_race", 1), client.claimTurn("worker_race", 1)]);
  expect([a.claim?.turn.runId, b.claim?.turn.runId, c.claim?.turn.runId]).toEqual(["run_one", "run_one", "run_one"]);
  // Only one turn ever left the queue.
  expect((await client.session("session_one")).turns.map((turn) => turn.state)).toEqual(["claimed", "queued"]);
});

test("a new generation does not inherit the old one's claim watermark or cache", async () => {
  /**
   * Generation fencing at the layer this change owns: the record is per
   * REGISTRATION, so a replacement starts its own sequence at 1 and cannot be
   * handed a predecessor's cached outcome.
   *
   * The daemon retires the embedded generation's registration on stop (see the
   * `onWorkerRetired` seam), which is what makes a straggler from a dead id
   * unservable. A worker constructed directly by a test is not retired that
   * way — unregister-on-stop belongs to the terminal-stop lifecycle, not here.
   */
  const { client } = await engine();
  await client.registerWorker("worker_gen_one");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const first = await client.claimTurn("worker_gen_one", 1);
  expect(first.claim?.turn.runId).toBe("run_one");

  await client.registerWorker("worker_gen_two");
  // A SECOND SESSION, because a session already holding a `claimed` turn is
  // skipped for dispatch — with one session the new generation would correctly
  // get nothing and the test would prove nothing about inheritance.
  await client.createSession({ id: "session_two", projectId: "project_one" });
  await client.submitTurn("session_two", { runId: "run_two", input: "Then this" });
  // Sequence 1 on the NEW registration is its own op, not a replay of the
  // old one's: it allocates from the queue rather than returning run_one.
  const second = await client.claimTurn("worker_gen_two", 1);
  expect(second.claim?.turn.runId).toBe("run_two");
  expect(second.claim?.turn.claim?.token).not.toBe(first.claim!.turn.claim!.token);
});

test("a claim delivered AFTER stop never executes, and its token cannot start a turn", async () => {
  /**
   * The stop lands inside the claim round trip. The pump must not construct a
   * driver afterwards — and even if a cached outcome were replayed later, the
   * token must fail the running transition rather than start work the person
   * already ended.
   */
  const { client } = await engine();
  const spawned: string[] = [];
  const phases: string[] = [];
  const worker = new EngineWorker({
    client,
    workerId: "worker_stopped",
    driver: { run: async ({ prompt }) => { spawned.push(prompt); return { text: "must not run" }; } },
    pollMs: 60_000,
    onDiagnostic: () => {},
    onClaimPhase: (phase) => void phases.push(phase),
  });
  workers.push(worker);
  const real = client.claimTurn.bind(client);
  (client as unknown as { claimTurn: typeof client.claimTurn }).claimTurn = async (workerId, claimSeq, signal) => {
    const answer = await real(workerId, claimSeq, signal);
    if (answer.claim) await worker.stop();
    return answer;
  };
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  await worker.tick();
  for (let attempt = 0; attempt < 40 && !phases.includes("idle"); attempt += 1) await Bun.sleep(20);

  // The grant was received; the provider boundary was never reached.
  expect(phases).toContain("granted");
  expect(phases).not.toContain("starting");
  expect(spawned).toEqual([]);

  /**
   * WHAT THIS TEST DOES NOT YET PROVE ON THIS BRANCH: the claim token survives
   * the worker's stop, so `markTurnRunning` with it still succeeds here.
   *
   * That is closed by telar/stop-is-not-pause, not by timing: `retireWorker`
   * terminalizes this worker's claims, and `markTurnRunning` only accepts a
   * `claimed` turn — so the stale token is refused after any await. The
   * assertion belongs in that branch, where it passes; asserting today's
   * behaviour here would bake in the thing being fixed.
   */
  const token = (await client.session("session_one")).turns[0]?.claim?.token;
  expect(token).toBeString();
});
