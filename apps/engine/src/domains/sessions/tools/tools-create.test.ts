import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { worktreeReady } from "../../../../test/worktree-ready";
import { defaultAsyncGitRunner, GIT_TIMEOUT_STATUS, type AsyncGitRunner } from "../../../platform/git/runner";
import { TELAR_SKILL } from "..";
import { cleanUp, capabilityOver, wall, engine, call } from "./test-helpers";

afterEach(cleanUp);

describe("creating a session", () => {
  test("a worktree session gets a real checkout of its own, and nothing is queued in it", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const created = await call(tools, "sessions_create", { projectId, title: "port the parser", envMode: "worktree" });

    expect(created.isError).toBe(false);
    const id = created.json!.id as string;
    expect(created.json!.envMode).toBe("worktree");
    expect(created.json!.branch).toBe(`telar/port-the-parser-${id.replace(/^session_/, "").slice(0, 6)}`);
    const session = store.getSession(id);
    expect(session.preparation).toMatchObject({ state: "preparing" });
    await worktreeReady(store, id);
    expect(fs.existsSync(path.join(session.workspace.path, "README.md"))).toBe(true);
    expect(store.turns(id)).toEqual([]);
    expect(String(created.json!.note)).toContain("Nothing is queued and nothing has started");
  });

  test("a local session shares the project's checkout, and says so", async () => {
    const { store, projectId, projectRoot } = engine();
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local" });
    expect(store.getSession(created.json!.id as string).workspace.path).toBe(fs.realpathSync(projectRoot));
    expect(created.json!.branch).toBeUndefined();
  });

  test("NOTHING records who created it — no parent, no child, no link", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const creator = store.createSession({ projectId, title: "the one doing the asking" });
    const created = await call(tools, "sessions_create", { projectId, envMode: "local" });
    const madeId = created.json!.id as string;

    const stored = fs.readFileSync(path.join(store.paths.sessions, madeId, "session.json"), "utf8");
    expect(stored).not.toContain(creator.id);
    expect(store.getSession(madeId).origin).toBe("session");
    expect(Object.keys(capabilityOver(store)).sort()).toEqual([
      "cohorts", "create", "diff", "list", "query", "read", "requests", "resolveRequest", "send", "settle", "status", "stop", "subscribe", "subscribeCohort", "subscriptions", "unsubscribe",
    ]);
  });

  test("a project that does not exist refuses with the store's own sentence", async () => {
    const { store } = engine();
    const refused = await call(wall(store), "sessions_create", { projectId: "nope", envMode: "local" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("nope");
  });
});

describe("there is no cap on creation", () => {
  test("twelve agent-made sessions succeed, and the prose promises no cap", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    for (let n = 0; n < 12; n++) {
      expect((await call(tools, "sessions_create", { projectId, envMode: "local", title: `worker ${n}` })).isError).toBe(false);
    }
    expect(store.liveSessions().sessions.filter((session) => session.origin === "session")).toHaveLength(12);
    const create = tools.get("sessions_create")!.description;
    expect(create).not.toContain("cap");
    expect(TELAR_SKILL).toContain("There is no cap, so the discipline is");
    expect(TELAR_SKILL).toContain("Create what the work needs and nothing more");
  });

  test("a refused create leaves NO worktree behind", async () => {
    const { store, projectId } = engine();
    const made = store.createSession({ projectId, envMode: "worktree", origin: "session" });
    await worktreeReady(store, made.id);
    const worktrees = path.join(store.paths.root, "worktrees");
    const before = fs.readdirSync(worktrees).length;
    expect(() => store.createSession({ projectId: "project_nope", envMode: "worktree", origin: "session" })).toThrow();
    expect(fs.readdirSync(worktrees).length).toBe(before);
  });
});

describe("a session whose checkout failed", () => {
  const CUT_FAILURE = "fatal: could not create work tree dir: No space left on device";
  const refusingCut: AsyncGitRunner = async (cwd, args, options) =>
    args[0] === "worktree" && args[1] === "add"
      ? { status: GIT_TIMEOUT_STATUS, stdout: "", stderr: CUT_FAILURE, timedOut: true }
      : defaultAsyncGitRunner(cwd, args, options);

  async function broken() {
    const { store, projectId } = engine({ asyncGit: refusingCut });
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "worktree", title: "port the parser" })).json!.id as string;
    await worktreeReady(store, id);
    expect(store.getSession(id).preparation?.state).toBe("failed");
    store.submitTurn(id, { runId: "run_one", input: "start" });
    return { store, tools, id };
  }

  test("sessions_status says it is NOT running, and names git's reason", async () => {
    const { tools, id } = await broken();
    const status = await call(tools, "sessions_status", { sessionId: id });

    expect(status.json!.running).toBe(false);
    expect(status.json!.preparation).toMatchObject({ state: "failed" });
    expect(String((status.json!.preparation as { error: string }).error)).toContain(CUT_FAILURE);
    const note = String(status.json!.note);
    expect(note).toContain(CUT_FAILURE);
    expect(note).not.toContain("Nothing is running.");
  });

  test("sessions_list carries the same state, so a scan of peers cannot miss it", async () => {
    const { tools, id } = await broken();
    const listed = await call(tools, "sessions_list");
    const row = (listed.json!.sessions as Array<{ id: string; preparation?: { state: string } }>).find((session) => session.id === id);
    expect(row?.preparation?.state).toBe("failed");
  });

  test("and an ordinary session carries neither key, so the row does not grow for everybody", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local" })).json!.id as string;
    const status = await call(tools, "sessions_status", { sessionId: id });
    expect(status.json!.preparation).toBeUndefined();
    expect(status.json!.running).toBe(false);
    expect(String(status.json!.note)).toContain("Nothing is running.");
    const listed = await call(tools, "sessions_list");
    const rows = listed.json!.sessions as Array<Record<string, unknown>>;
    expect(rows.filter((row) => "preparation" in row)).toHaveLength(0);
  });

  test("a cut still in flight is reported as not running either, and says which of the two it is", async () => {
    const hanging: AsyncGitRunner = (cwd, args, options) =>
      args[0] === "worktree" && args[1] === "add" ? new Promise(() => {}) : defaultAsyncGitRunner(cwd, args, options);
    const { store, projectId } = engine({ asyncGit: hanging });
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "worktree" })).json!.id as string;
    store.submitTurn(id, { runId: "run_one", input: "start" });

    const status = await call(tools, "sessions_status", { sessionId: id });
    expect(status.json!.running).toBe(false);
    expect(status.json!.preparation).toMatchObject({ state: "preparing" });
    const note = String(status.json!.note);
    expect(note).toContain("still being made");
    expect(note).not.toContain(CUT_FAILURE);
  });
});
