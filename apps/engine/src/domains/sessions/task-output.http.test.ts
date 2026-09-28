/**
 * `GET /v2/sessions/:id/tasks/:taskId/output` against a real daemon, store and
 * worker: the path the driver stored is the only one the route will read.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import type { TurnDriver } from "../../drivers";
import { EngineWorker } from "../../worker";
import { stubModels } from "../../../test/stub-models";
import { until } from "../../../test/wait";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];
const previousTmp = process.env.CLAUDE_CODE_TMPDIR;

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  if (previousTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = previousTmp;
});

test("a background task's log is read from the path its driver stored, and nothing else is", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-claude-tmp-")));
  roots.push(tmp);
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  const tasks = path.join(tmp, `claude-${process.getuid!()}`, "-proj", "sess", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const log = path.join(tasks, "bsh1.output");
  fs.writeFileSync(log, "listening on 3000\n");
  const elsewhere = path.join(tmp, "not-a-log.output");
  fs.writeFileSync(elsewhere, "secret\n");

  const driver: TurnDriver = {
    run: async ({ onObservations }) => {
      await onObservations([
        { kind: "task.started", task: { id: "task_shell", providerTaskId: "bsh1", kind: "background", state: "running", title: "dev", outputFile: log } },
        { kind: "task.started", task: { id: "task_stray", providerTaskId: "not-a-log", kind: "background", state: "running", title: "x", outputFile: elsewhere } },
        { kind: "task.started", task: { id: "task_agent", providerTaskId: "ag1", kind: "agent", state: "running", title: "a", outputFile: log } },
      ]);
      return { text: "started" };
    },
  };

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-taskout-"));
  roots.push(directory);
  const daemon = await startEngine({ models: stubModels, engineRoot: directory, workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  const worker = new EngineWorker({ client, workerId: "worker_log", driver, pollMs: 10, onDiagnostic: () => {} });
  workers.push(worker);
  await worker.start();
  await client.submitTurn("session_one", { runId: "run_one", input: "start the server" });
  await until("the tasks to land", async () => (await client.session("session_one")).tasks.length === 3);

  const first = await client.taskOutput("session_one", "task_shell");
  expect(first).toMatchObject({ text: "listening on 3000\n", missing: false });
  fs.appendFileSync(log, "GET / 200\n");
  expect(await client.taskOutput("session_one", "task_shell", first.cursor)).toMatchObject({ text: "GET / 200\n" });

  // Outside `tasks/` under Claude's root, an agent's row, a task that is not there.
  await expect(client.taskOutput("session_one", "task_stray")).rejects.toThrow();
  await expect(client.taskOutput("session_one", "task_agent")).rejects.toThrow();
  await expect(client.taskOutput("session_one", "task_nobody")).rejects.toThrow();
});
