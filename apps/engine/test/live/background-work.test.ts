/**
 * THE REGRESSION NET FOR LONG-HORIZON TURNS, against the real Claude Code CLI.
 *
 * OPT-IN: `TELAR_LIVE_CLI=1 bun test test/live`. Skipped otherwise, because it
 * spawns a real `claude` process, spends real tokens, and takes ~30 s. This is
 * what "trust it with a long task" means operationally, and the fake-SDK tests
 * cannot say it: only the real CLI knows when it wakes the model on a
 * background task's ending, what frames it emits, and in which order.
 *
 * Three cases, each measured broken before the session-lived pump landed:
 *   1. A backgrounded shell ends between turns → its row closes and a provider
 *      turn appears, with NO human message.
 *   2. A Monitor emits two lines → two wake-ups.
 *   3. An engine restart mid-monitor → the row is stopped, activity is idle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../src/daemon";
import { createDefaultDrivers } from "../../src/drivers";
import { EngineWorker } from "../../src/worker";

const LIVE = process.env.TELAR_LIVE_CLI === "1";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function eventually(check: () => void | Promise<void>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(250);
    }
  }
  throw last;
}

async function stack(engineRoot: string) {
  const daemon = await startEngine({ engineRoot, workerLeaseMs: 5_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-project-"));
  roots.push(projectRoot);
  const project = await client.registerProject({ id: "project_live", name: "Live", root: projectRoot });
  // `full-access` so no tool call parks on a human: the point is the wake-up
  // path, not the approval path (which the fake-SDK tests cover).
  const session = await client.createSession({ id: "session_live", projectId: project.project.id });
  await client.updateSession(session.session.id, { runtimeMode: "full-access" });
  const worker = new EngineWorker({ client, workerId: "worker_live", driver: createDefaultDrivers(), pollMs: 200 });
  workers.push(worker);
  await worker.start();
  return { client, sessionId: session.session.id, worker, daemon };
}

describe.skipIf(!LIVE)("cross-turn background work, against the real CLI", () => {
  test("a backgrounded shell that ends between turns closes its row and wakes the model — no human message", async () => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-engine-"));
    roots.push(engineRoot);
    const { client, sessionId } = await stack(engineRoot);

    await client.submitTurn(sessionId, {
      runId: "run_one",
      input:
        "Run this exact shell command IN THE BACKGROUND using the Bash tool with run_in_background=true: `sleep 6; echo DONE_MARKER`. " +
        "Then reply with exactly the word 'started' and end your turn. When the background task later notifies you, reply with exactly 'woke: <its output>'.",
    });
    await eventually(async () => expect((await client.session(sessionId)).turns.find((t) => t.runId === "run_one")?.state).toBe("completed"));

    // The shell is live and the session says so.
    await eventually(async () => {
      const snapshot = await client.session(sessionId);
      expect(snapshot.tasks.some((task) => task.kind === "background" && task.state === "running")).toBe(true);
      expect(snapshot.session.activity).toBe("monitoring");
    });

    // NO SECOND HUMAN TURN. The row closes and a provider turn appears.
    await eventually(async () => {
      const snapshot = await client.session(sessionId);
      const shell = snapshot.tasks.find((task) => task.kind === "background");
      expect(shell?.state).toBe("completed");
      const wake = snapshot.turns.find((turn) => turn.origin === "provider");
      expect(wake).toBeDefined();
      expect(wake?.providerReason?.kind).toBe("task_notification");
      expect(wake?.state).toBe("completed");
      expect(wake?.resultText?.toLowerCase()).toContain("woke");
    }, 45_000);
    const finalSnapshot = await client.session(sessionId);
    expect(finalSnapshot.session.activity).toBe("idle");
    expect(finalSnapshot.turns.filter((turn) => turn.origin !== "provider")).toHaveLength(1);
  }, 120_000);

  test("a Monitor that emits two lines wakes the model twice", async () => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-engine-"));
    roots.push(engineRoot);
    const { client, sessionId } = await stack(engineRoot);

    await client.submitTurn(sessionId, {
      runId: "run_one",
      input:
        "Use the Monitor tool with this exact command: `sleep 3; echo TICK_ONE; sleep 3; echo TICK_TWO` and description 'two ticks'. " +
        "Then reply with exactly 'watching' and end your turn. Each time the monitor notifies you, reply with exactly 'tick: <the line>'.",
    });
    await eventually(async () => expect((await client.session(sessionId)).turns.find((t) => t.runId === "run_one")?.state).toBe("completed"));
    await eventually(async () => {
      const snapshot = await client.session(sessionId);
      const wakes = snapshot.turns.filter((turn) => turn.origin === "provider" && turn.state === "completed");
      expect(wakes.length).toBeGreaterThanOrEqual(2);
    }, 60_000);
  }, 120_000);

  test("an engine restart mid-monitor stops the row and leaves the session idle", async () => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-engine-"));
    roots.push(engineRoot);
    const first = await stack(engineRoot);

    await first.client.submitTurn(first.sessionId, {
      runId: "run_one",
      input: "Run `sleep 120` IN THE BACKGROUND with the Bash tool (run_in_background=true), reply with exactly 'started', and end your turn.",
    });
    await eventually(async () => expect((await first.client.session(first.sessionId)).turns[0]?.state).toBe("completed"));
    await eventually(async () => expect((await first.client.session(first.sessionId)).session.activity).toBe("monitoring"));

    // The engine restarts: the worker (and its CLI) die with it.
    await workers.splice(0).reverse()[0]!.stop();
    await daemons.splice(0).reverse()[0]!.close();
    const restarted = await startEngine({ engineRoot, workerLeaseMs: 5_000 });
    daemons.push(restarted);
    const client = new EngineClient(restarted.discovery);
    const snapshot = await client.session(first.sessionId);
    expect(snapshot.tasks.find((task) => task.kind === "background")).toMatchObject({ state: "stopped", failure: "the process that owned this task is gone" });
    expect(snapshot.session.activity).toBe("idle");
  }, 120_000);
});
