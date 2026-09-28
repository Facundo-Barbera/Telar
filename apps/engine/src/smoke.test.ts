/**
 * One call per migrated domain, through the typed client against a real engine
 * in a temp home: the checkpoint that the split contract and the engine agree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { EngineClient, type EngineEvent } from "@telar/engine-client";
import { normalizeOutcome, type TurnDriver } from "./drivers";
import { startEngine, type EngineDaemon } from "./daemon";
import { EngineWorker } from "./worker";
import { stubModels } from "../test/stub-models";
import { eventually } from "../test/wait";
import { engineHome, removeTmp, repo } from "../test/worktree-fixtures";

let daemon: EngineDaemon;
let worker: EngineWorker;
let client: EngineClient;
let checkout: string;
const PROJECT = "project_smoke";
const LOCAL = "session_local";
const WORKTREE = "session_worktree";

const driver: TurnDriver = {
  async run({ prompt, onObservations, onRequest }) {
    await onObservations([
      { kind: "item.started", item: { id: "answer", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: "answer", stream: "assistant_text", text: `echo:${prompt}` },
      { kind: "item.completed", itemId: "answer", status: "completed" },
    ]);
    if (prompt === "ask" && onRequest) {
      const outcome = normalizeOutcome(
        await onRequest({ kind: "command_execution", detail: { kind: "command_execution", command: { command: "rm -rf build" } }, toolUseId: "toolu_smoke" }),
      );
      return { text: `decided:${outcome.decision}` };
    }
    return { text: `echo:${prompt}` };
  },
};

const types = (events: EngineEvent[]) => events.map((event) => event.type);

beforeAll(async () => {
  checkout = repo();
  daemon = await startEngine({ models: stubModels, engineRoot: engineHome("telar-smoke-"), workerLeaseMs: 60_000, notifier: () => true });
  client = new EngineClient(daemon.discovery);
  worker = new EngineWorker({ client, workerId: "worker_smoke", driver, pollMs: 25 });
  await worker.start();
});

afterAll(async () => {
  await worker?.stop();
  await daemon?.close();
  removeTmp();
});

describe("smoke: every migrated domain through the typed client", () => {
  test("remote gate: the engine token is required", async () => {
    const base = `http://${daemon.discovery.host}:${daemon.discovery.port}`;
    expect((await fetch(`${base}/v2/health`)).status).toBe(401);
    expect((await fetch(`${base}/v2/health`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(await client.health()).toMatchObject({ daemonId: daemon.discovery.daemonId });
    const remote = await fetch(`${base}/v2/remote`, { headers: { authorization: `Bearer ${daemon.discovery.token}` } });
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({ requireAuth: expect.any(Boolean), devices: expect.any(Array) });
  });

  test("projects: register and list", async () => {
    const { project } = await client.registerProject({ id: PROJECT, name: "Smoke", root: checkout });
    expect(project.id).toBe(PROJECT);
    expect((await client.listProjects()).projects.map((row) => row.id)).toContain(PROJECT);
  });

  test("sessions: a local and a worktree session", async () => {
    expect((await client.createSession({ id: LOCAL, projectId: PROJECT, envMode: "local" })).session.id).toBe(LOCAL);
    await client.createSession({ id: WORKTREE, projectId: PROJECT, envMode: "worktree" });
    await eventually(async () => {
      const { session } = await client.session(WORKTREE);
      expect(session.preparation?.state ?? "ready").not.toBe("preparing");
      expect(session.workspace).toMatchObject({ mode: "worktree", branch: expect.any(String) });
    });
    expect((await client.liveSessions()).sessions.map((row) => row.id)).toEqual(expect.arrayContaining([LOCAL, WORKTREE]));
  });

  test("turns: a turn runs, and the journal and items show it", async () => {
    await client.submitTurn(LOCAL, { runId: "run_hello", input: "hello" });
    await eventually(async () => expect((await client.session(LOCAL)).turns.find((turn) => turn.runId === "run_hello")?.state).toBe("completed"));
    const journal = await client.drainEvents(LOCAL);
    expect(types(journal.events)).toEqual(expect.arrayContaining(["turn.accepted", "turn.completed"]));
    const { items } = await client.runItems(LOCAL, "run_hello");
    expect(items.length).toBeGreaterThan(0);
    expect((await client.turnAnswer(LOCAL, { runId: "run_hello" })).text).toContain("echo:hello");
  });

  test("requests: a parked permission request resolves through the client", async () => {
    await client.updateSession(LOCAL, { runtimeMode: "approval-required" });
    await client.submitTurn(LOCAL, { runId: "run_ask", input: "ask" });
    let requestId = "";
    await eventually(async () => {
      const open = (await client.session(LOCAL)).requests.filter((request) => request.state === "open");
      expect(open).toHaveLength(1);
      requestId = open[0]!.id;
    });
    await client.resolveRequest(LOCAL, requestId, { decision: "accept" });
    await eventually(async () => expect((await client.turnAnswer(LOCAL, { runId: "run_ask" })).text).toBe("decided:accept"));
  });

  test("settling: settle and unsettle", async () => {
    expect((await client.settleSession(LOCAL, true)).session.settledOverride).toBe("settled");
    expect((await client.settleSession(LOCAL, false)).session.settledOverride).toBe("active");
  });

  test("notes and prompts", async () => {
    const { note } = await client.createProjectNote(PROJECT, { title: "Smoke", body: "checked" });
    expect((await client.projectNotes(PROJECT)).notes.map((row) => row.id)).toContain(note.id);
    expect((await client.deleteProjectNote(PROJECT, note.id)).deleted).toBe(true);
    const { prompt } = await client.createProjectPrompt(PROJECT, { title: "Again", text: "run it again" });
    expect((await client.projectPrompts(PROJECT)).prompts.map((row) => row.id)).toContain(prompt.id);
  });

  test("schedules: put, list, delete", async () => {
    const { schedule } = await client.putSchedule({ sessionId: LOCAL, prompt: "tick", rule: { kind: "interval", everyMs: 3_600_000 }, zone: "UTC" });
    expect((await client.schedules(LOCAL)).schedules.map((row) => row.id)).toContain(schedule.id);
    expect((await client.deleteSchedule(schedule.id)).deleted).toBe(true);
  });

  test("terminal: a saved configuration runs to its exit", async () => {
    const config = await client.createRunConfiguration(WORKTREE, { name: "Echo", command: "echo smoke-run" });
    const run = await client.startRun(WORKTREE, { configId: config.id });
    const waited = await client.runWait(WORKTREE, { terminalId: run.terminalId, exit: true, timeoutMs: 15_000 });
    expect(waited.fired).toBe("exit");
    const output = await client.runOutput(WORKTREE, { terminalId: run.terminalId });
    expect(output.lines.map((line) => line.text).join("\n")).toContain("smoke-run");
    expect((await client.runStatus(WORKTREE)).terminals.map((row) => row.terminalId)).toContain(run.terminalId);
  });

  test("files: list, read, write with the hash", async () => {
    expect((await client.projectFiles(PROJECT)).listing.files).toContain("README.md");
    const { file } = await client.sessionFile(WORKTREE, "README.md");
    const written = await client.writeSessionFile(WORKTREE, "README.md", "hello from smoke\n", file.sha256);
    expect(written.written).toBe(true);
    expect((await client.sessionFile(WORKTREE, "README.md")).file.text).toBe("hello from smoke\n");
  });

  test("git: overview and the session's diff", async () => {
    expect((await client.projectGit(PROJECT)).git).toMatchObject({ repository: true, branch: "main" });
    const { diff } = await client.sessionDiff(WORKTREE);
    expect(diff.repository).toBe(true);
    expect(diff.files.map((change) => change.path)).toContain("README.md");
    const { file } = await client.sessionFilePatch(WORKTREE, "README.md");
    expect(file.patch).toContain("hello from smoke");
  });

  test("plugins, storage, appearance and settings answer", async () => {
    expect((await client.machinePlugins()).plugins.length).toBeGreaterThan(0);
    expect((await client.storage()).storage.root).toBeString();
    expect((await client.appearanceHome()).looks).toBeArray();
    expect((await client.inboxPolicy()).inbox).toBeObject();
    expect((await client.usageLimitSources()).sources).toBeArray();
    expect((await client.worktreesRoot()).worktreesRoot.kind).toBeString();
  });

  test("stays inside its temp home, worktrees included", async () => {
    const home = fs.realpathSync(daemon.store.paths.root);
    expect(home.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    const { session } = await client.session(WORKTREE);
    expect(session.workspace.mode === "worktree" && fs.realpathSync(session.workspace.path).startsWith(home)).toBe(true);
  });
});
