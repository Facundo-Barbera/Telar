import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { worktreeReady } from "../../../../test/worktree-ready";
import { STALLED_AFTER_MS, workspacePath } from "@telar/engine-client";
import { EngineStore } from "../../../state";
import { sessionDiffAsync } from "../../git";
import { GIT_TIMEOUT_STATUS, type GitRunner } from "../../../platform/git/runner";
import { cleanUp, tmp, repo, openStores, wall, engine, call } from "./test-helpers";

afterEach(cleanUp);

describe("driving a session", () => {
  test("send stays passive while the recipient is WORKING, and does not promise an answer", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    store.intake.submitTurn(id, { runId: "run_busy", input: "a long think" });
    const token = store.claims.claimTurn(id, "worker_busy")!.claim!.token;
    store.turnLifecycle.markRunning(id, "run_busy", token);
    const sent = await call(tools, "sessions_send", { sessionId: id, input: "routine checkpoint" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.delivery).toBe("passive");
    expect(String(sent.json!.note)).toContain("No model was started or steered");
    expect(store.claims.claimTurn(id, "worker_test")).toBeUndefined();
  });

  test("send to an IDLE session is held as mail, not turned into a turn", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const sent = await call(tools, "sessions_send", { sessionId: id, input: "routine checkpoint" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.delivery).toBe("passive");
    expect(store.claims.claimTurn(id, "worker_test")).toBeUndefined();
    expect(store.wakes.pendingNotifications(id)).toHaveLength(1);
  });

  test("send queues one turn and says plainly that it is not the answer", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const sent = await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "read the parser and report" });
    expect(sent.isError).toBe(false);
    expect(sent.json!.state).toBe("queued");
    expect(String(sent.json!.note)).toContain("Accepted for execution, not answered");
    expect(store.queries.turns(id).map((turn) => turn.input)).toEqual(["read the parser and report"]);
    expect(tools.get("sessions_send")!.shape).not.toHaveProperty("runId");
  });

  test("status answers the question it exists for as a boolean, not an inference", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const idle = await call(tools, "sessions_status", { sessionId: id });
    expect(idle.json!.running).toBe(false);
    expect(String(idle.json!.note)).toContain("Nothing is running");

    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "go" });
    const busy = await call(tools, "sessions_status", { sessionId: id });
    expect(busy.json!.running).toBe(true);
    expect((busy.json!.turns as unknown[]).length).toBe(1);
  });

  test("settle shelves a session without archiving it, and a new message lifts it back", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const settled = await call(tools, "sessions_settle", { sessionId: id });
    expect(settled.isError).toBe(false);
    expect(settled.json).toMatchObject({ sessionId: id, settled: true });
    expect(String(settled.json!.note)).toContain("Nothing was archived");
    expect(store.records.get(id)).toMatchObject({ state: "active", settledOverride: "settled" });

    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "one more thing" });
    expect(store.records.get(id).settledOverride).toBeUndefined();

    const back = await call(tools, "sessions_settle", { sessionId: id, settled: false });
    expect(store.records.get(id).settledOverride).toBe("active");
    expect(String(back.json!.note)).toContain("Back in the active list");

    const missing = await call(tools, "sessions_settle", { sessionId: "session_nope" });
    expect(missing.isError).toBe(true);
  });

  test("settle says what it ended: the session's terminals, closed as Telar (#883)", async () => {
    const { store, projectId } = engine();
    const closed: string[] = [];
    store.sessionTerminals.attach({ openCount: () => 0, openSessions: () => [], closeSession: async (sessionId) => (closed.push(sessionId), 2) });
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;

    const settled = await call(tools, "sessions_settle", { sessionId: id });
    expect(closed).toEqual([id]);
    expect(settled.json).toMatchObject({ ended: { terminals: 2, backgroundTasks: 0 } });
    expect(String(settled.json!.note)).toContain("Settling ended what it left running: 2 terminals.");

    await call(tools, "sessions_settle", { sessionId: id, settled: false });
    expect(closed).toEqual([id]);
  });

  test("status lists the mail a session is holding, so held never reads as lost", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "coordinator" });
    const worker = store.lifecycle.createSession({ projectId, title: "worker" });
    const tools = wall(store, { sessionId: host.id });

    store.intake.submitTurn(worker.id, { runId: "run_source", input: "work" });
    const token = store.claims.claimTurn(worker.id, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(worker.id, "run_source", token);
    store.intake.submitAgentTurn(host.id, { runId: "run_report", input: "progress", intent: "report" }, { sessionId: worker.id, runId: "run_source", claimToken: token });

    const status = await call(tools, "sessions_status", { sessionId: host.id });
    expect((status.json!.pendingNotifications as string[]).length).toBe(1);
    expect(status.json!.running).toBe(false);
  });

  test("stop STOPS the session: the running turn ends, what was queued is settled, and it is idle after", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "go" });
    const claimed = store.claims.claimTurn(id, "worker_one")!;
    store.turnLifecycle.markRunning(id, claimed.runId, claimed.claim!.token);
    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "and then this" });

    const stopped = await call(tools, "sessions_stop", { sessionId: id });
    expect(stopped.json!).toMatchObject({ stopped: 2, runId: claimed.runId, state: "stopped" });
    expect(String(stopped.json!.note)).toContain("stopping ends work, it never undoes it");
    expect(String(stopped.json!.note)).toContain("IDLE now, not paused");
    expect(store.records.get(id).paused).toBeUndefined();
    const [first, second] = store.queries.turns(id);
    expect(first!.state).toBe("stopped");
    expect(second).toMatchObject({ state: "stopped", stopReason: "agent", input: "and then this" });
    expect(second!.held).toBeUndefined();
    expect(store.claims.claimNextTurn("worker_two")).toBeUndefined();
    expect([...tools.keys()]).not.toContain("sessions_resume");

    await call(tools, "sessions_send", { intent: "task", sessionId: id, input: "carry on" });
    expect(store.claims.claimNextTurn("worker_two")?.turn.input).toBe("carry on");

    const again = await call(tools, "sessions_stop", { sessionId: id });
    expect(again.isError).toBe(false);
  });

  test("diff reads the session's own checkout and says it accepts nothing", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "worktree" })).json!.id as string;
    await worktreeReady(store, id);
    fs.writeFileSync(path.join(workspacePath(store.records.get(id).workspace)!, "new-file.txt"), "written by the session\n");

    const diff = await call(tools, "sessions_read", { sessionId: id, view: "diff" });
    expect((diff.json!.files as Array<{ path: string }>).map((file) => file.path)).toContain("new-file.txt");
    expect(String(diff.json!.note)).toContain("Nothing here merges, lands or approves");
    expect(diff.json!.filesIncomplete).toBeUndefined();
    expect(diff.json!.askAgain).toBeUndefined();
  });

  test("a diff that timed out is never reported as a session that changed nothing", async () => {
    const { store, projectId } = engine();
    const id = (await call(wall(store), "sessions_create", { projectId, envMode: "worktree" })).json!.id as string;
    await worktreeReady(store, id);
    const killed: GitRunner = (_cwd, args) =>
      args[0] === "rev-parse" && args[1] === "--is-inside-work-tree"
        ? { status: 0, stdout: "true\n", stderr: "" }
        : { status: GIT_TIMEOUT_STATUS, stdout: "", stderr: "git did not finish within 30000ms and was killed", timedOut: true };
    const tools = wall(store, undefined, async (sessionId) =>
      await sessionDiffAsync(async (cwd, args) => killed(cwd, args), { cwd: workspacePath(store.records.get(sessionId).workspace)!, baseRef: "base000" }),
    );

    const diff = await call(tools, "sessions_read", { sessionId: id, view: "diff" });
    expect(diff.isError).toBe(false);
    expect(diff.json!).toMatchObject({ filesIncomplete: "timeout", commitsIncomplete: "timeout", baseUnverified: "timeout", askAgain: true });
    expect(diff.json!.fileCount).toBe(0);
    const note = String(diff.json!.note);
    expect(note).not.toContain("changed nothing in its checkout");
    expect(note).toContain("do not report this session as having changed nothing");
    expect(note).toContain("read it again");
    expect(tools.get("sessions_read")!.description).toContain("an empty diff may be unread, not unchanged");
  });

  test("a session that does not exist refuses identically on every verb", async () => {
    const { store } = engine();
    const tools = wall(store);
    for (const [name, view] of [["sessions_send"], ["sessions_read"], ["sessions_status"], ["sessions_read", "diff"]] as const) {
      const refused = await call(tools, name, { sessionId: "session_nope", input: "x", ...(view ? { view } : {}) });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("session does not exist");
    }
  });

  test("list shows every live session across projects, and the projects one could be made in", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const made = (await call(tools, "sessions_create", { projectId, title: "made by an agent", envMode: "local" })).json!.id as string;
    const byHand = store.lifecycle.createSession({ projectId, title: "made by a person" }).id;
    const gone = store.lifecycle.createSession({ projectId, title: "finished" }).id;
    store.lifecycle.archiveSession(gone);

    const listed = await call(tools, "sessions_list");
    const ids = (listed.json!.sessions as Array<{ id: string; project: string }>).map((session) => session.id);
    expect(ids).toContain(made);
    expect(ids).toContain(byHand);
    expect(ids).not.toContain(gone);
    expect((listed.json!.projects as Array<{ id: string; name: string }>)[0]!.name).toBe("aurora");
    expect((listed.json!.sessions as Array<{ project: string }>)[0]!.project).toBe("aurora");
  });
});

describe("sessions_status reports a stalled turn", () => {
  test("it names the silence, keeps the turn running, and tells nobody to stop it", async () => {
    let now = 1_000_000;
    const timed = new EngineStore(tmp("telar-stall-wall-"), () => now);
    openStores.push(timed);
    const project = timed.projectRegistry.register({ name: "aurora", root: repo() });
    const session = timed.lifecycle.createSession({ projectId: project.id, envMode: "local" });
    timed.intake.submitTurn(session.id, { runId: "run_one", input: "run the suite" });
    const claim = timed.claims.claimNextTurn("worker_one")!;
    timed.turnLifecycle.markRunning(session.id, "run_one", claim.turn.claim!.token);

    const tools = wall(timed);
    const healthy = await call(tools, "sessions_status", { sessionId: session.id });
    expect(healthy.json!.running).toBe(true);
    expect((healthy.json!.turns as Array<Record<string, unknown>>)[0]!.stalled).toBeUndefined();

    now += STALLED_AFTER_MS + 60_000;
    timed.claims.claimNextTurn("worker_one");

    const stalled = await call(tools, "sessions_status", { sessionId: session.id });
    const turns = stalled.json!.turns as Array<{ state: string; stalled?: { since: number }; lastProgressAt?: number }>;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.state).toBe("running");
    expect(stalled.json!.running).toBe(true);
    expect(turns[0]!.stalled?.since).toBe(claim.turn.acceptedAt);
    expect(turns[0]!.lastProgressAt).toBe(turns[0]!.stalled!.since);
    const note = String(stalled.json!.note);
    expect(note).toContain(String(Math.round(STALLED_AFTER_MS / 60_000)));
    expect(note).toContain("Nothing has been stopped.");
    expect(note).not.toContain("sessions_stop");
  });
});

describe("sessions_status says what a session with no turn is still doing", () => {
  test("background work is counted and will report", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    store.intake.submitTurn(id, { runId: "run_bg", input: "Fan out" });
    const claimed = store.claims.claimNextTurn("worker_one")!;
    const token = claimed.turn.claim!.token;
    store.turnLifecycle.markRunning(id, "run_bg", token);
    store.ingest.ingestObservations(id, "run_bg", token, [
      { kind: "task.started", task: { id: "task_a", kind: "agent", backgrounded: true, state: "running" } },
      { kind: "task.started", task: { id: "task_b", kind: "background", backgrounded: true, state: "running" } },
    ]);
    store.turnLifecycle.completeTurn(id, "run_bg", token, { text: "Launched" });

    const status = await call(tools, "sessions_status", { sessionId: id });
    expect(status.json!.running).toBe(false);
    expect(status.json!.activityDetail).toEqual({ kind: "background", tasks: 2, agents: 1 });
    expect(String(status.json!.note)).toBe("Its turn has ended, but 2 background tasks (1 of them agent) still run. A report from them will wake it; subscribe rather than poll.");
  });

  test("a session waiting on another names it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const waiter = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const worker = (await call(tools, "sessions_create", { projectId, envMode: "local", title: "port the parser" })).json!.id as string;
    store.subscriptions.subscribe(waiter, { targetSessionId: worker });
    store.intake.submitTurn(worker, { runId: "run_w", input: "go" });

    const status = await call(tools, "sessions_status", { sessionId: waiter });
    expect(status.json!.activity).toBe("waiting");
    expect(String(status.json!.note)).toBe(`Nothing is running. It is waiting on “port the parser” (${worker}), and their answer will wake it.`);
  });
});
