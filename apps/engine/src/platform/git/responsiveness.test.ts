import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { defaultAsyncGitRunner, type GitResult } from "./runner";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
function root() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "telar-poll-"));
  roots.push(result);
  return result;
}
afterEach(() => { for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

/** One macrotask turn: every microtask queued before it has already run. */
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A real repository with one commit — the worktree route's own probes run
 *  against this rather than a fake. */
function repo(): string {
  const directory = root();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(directory, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return directory;
}

test("sidebar and direct project lookup stay responsive while metadata Git is stalled", async () => {
  /** What each refresh asked, so the count is a number of PASSES rather than of
   *  processes — the metadata refresh reads the branch and the origin, and what
   *  this test is about is that twenty reads share one pass. */
  const asked: string[] = [];
  let finish!: (result: GitResult) => void;
  const waiting = new Promise<GitResult>((resolve) => { finish = resolve; });
  const store = new EngineStore(root(), Date.now, {
    git: () => { throw new Error("synchronous Git must not run on project reads"); },
    asyncGit: async (_cwd, args) => { asked.push(args.join(" ")); return waiting; },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  // Every read answers while the Git it started is still pending: nothing here waits on it.
  for (let i = 0; i < 20; i++) {
    expect(store.projectRegistry.list()[0]?.id).toBe("project_one");
    expect(store.projectRegistry.get("project_one").name).toBe("One");
  }
  expect(asked).toEqual(["rev-parse --abbrev-ref HEAD", "config --get remote.origin.url"]);
  finish({ status: 0, stdout: "main\n", stderr: "" });
  for (let i = 0; i < 100 && store.projectRegistry.list()[0]?.branch !== "main"; i++) await macrotask();
  expect(store.projectRegistry.list()[0]?.branch).toBe("main");
  expect(asked).toHaveLength(2);
});

test("concurrent review polls share one pending Git read and expire their short cache", async () => {
  let now = 1;
  let calls = 0;
  let finish!: (result: GitResult) => void;
  const waiting = new Promise<GitResult>((resolve) => { finish = resolve; });
  const store = new EngineStore(root(), () => now, {
    asyncGit: async () => { calls++; return waiting; },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  const first = store.workspaceReads.projectOverview("project_one");
  const second = store.workspaceReads.projectOverview("project_one");
  await Promise.resolve();
  expect(calls).toBe(1);
  finish({ status: 128, stdout: "", stderr: "not a repository" });
  expect(await first).toEqual(await second);
  await store.workspaceReads.projectOverview("project_one");
  expect(calls).toBe(1);
  now += 2_001;
  await store.workspaceReads.projectOverview("project_one");
  expect(calls).toBe(2);
});

test("async patch reads retain the project path fence", () => {
  const store = new EngineStore(root());
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  expect(() => store.workspaceReads.projectFilePatch("project_one", "../../etc/passwd")).toThrow("outside the workspace");
});


test("HTTP health and sidebar requests respond while review Git remains pending", async () => {
  const { startEngine } = await import("../../daemon");
  let release!: (result: GitResult) => void;
  const stalled = new Promise<GitResult>((resolve) => { release = resolve; });
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), asyncGit: async () => stalled });
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}` };
  daemon.store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  const review = fetch(`${base}/v2/projects/project_one/git`, { headers });
  try {
    // The review's Git never answers until `finally`, so every response here arrived while it was pending.
    for (let i = 0; i < 10; i++) {
      const responses = await Promise.all([
        fetch(`${base}/v2/health`, { headers }),
        fetch(`${base}/v2/projects`, { headers }),
      ]);
      for (const response of responses) { expect(response.ok).toBeTrue(); await response.json(); }
    }
  } finally {
    release({ status: 128, stdout: "", stderr: "not a repository" });
    await (await review).text();
    await daemon.close();
  }
});

// The cut used to run synchronously inside `POST /v2/sessions`; with a `worktree add` that never finishes, no route would answer.
test("a stalled worktree add delays neither its own route nor an unrelated one", async () => {
  const { startEngine } = await import("../../daemon");
  const projectRoot = repo();
  let released!: (result: GitResult) => void;
  const stalled = new Promise<GitResult>((resolve) => { released = resolve; });
  let adds = 0;
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    // Only the cut stalls. The request-side probes (`--is-inside-work-tree`,
    // `rev-parse`) are prefetched through this same runner against the real repo.
    asyncGit: async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "add") { adds++; return stalled; }
      return defaultAsyncGitRunner(cwd, args, options);
    },
  });
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" };
  daemon.store.projectRegistry.register({ id: "project_one", name: "One", root: projectRoot });
  try {
    const created = await fetch(`${base}/v2/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "session_one", projectId: "project_one", envMode: "worktree" }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json();
    // The route answered with a complete row whose checkout is still being made.
    expect(session.preparation).toMatchObject({ state: "preparing" });
    expect(session.workspace.branch).toBe("telar/session_one");

    // …and other routes answer while the cut still hangs: `stalled` only resolves in `finally`.
    for (let i = 0; i < 10; i++) {
      const responses = await Promise.all([
        fetch(`${base}/v2/health`, { headers }),
        fetch(`${base}/v2/sessions/live`, { headers }),
      ]);
      for (const response of responses) { expect(response.ok).toBeTrue(); await response.json(); }
    }
    // The stall was real: the cut was actually attempted and is still pending.
    expect(adds).toBe(1);
    expect(daemon.store.records.get("session_one").preparation?.state).toBe("preparing");
  } finally {
    released({ status: 0, stdout: "", stderr: "" });
    await daemon.close();
  }
});

/**
 * A git the test holds: every call is recorded, and while the gate is shut it
 * answers nobody. Answers are enough for a checkout that HEAD resolves in.
 */
function gatedGit() {
  const calls: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  const SHA = "a".repeat(40);
  const answer = (args: string[]): GitResult => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { status: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { status: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    SHA,
    calls,
    shut: () => { gate = new Promise((resolve) => { open = resolve; }); },
    open: () => open(),
    runner: async (_cwd: string, args: string[]): Promise<GitResult> => {
      calls.push(args.join(" "));
      await gate;
      return answer(args);
    },
  };
}

test("a pending session create, draft promotion, diff and overview leave the event loop serving", async () => {
  const git = gatedGit();
  const store = new EngineStore(root(), Date.now, {
    git: () => { throw new Error("synchronous git must not run on the request path"); },
    asyncGit: git.runner,
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  // Made while the gate is open: the session whose stream the test appends to.
  await store.requestPath.createSession({ id: "session_live", projectId: "project_one", envMode: "local" });
  await store.requestPath.createSession({ id: "session_draft", projectId: "project_one", envMode: "worktree", draft: true });

  git.shut();
  const before = git.calls.length;
  const pending = Promise.all([
    store.requestPath.createSession({ id: "session_new", projectId: "project_one", envMode: "local" }),
    store.requestPath.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" }),
    store.requestPath.submitTurn("session_draft", { runId: "run_draft", input: "promote me" }),
    store.workspaceReads.sessionDiff("session_live"),
    store.workspaceReads.projectOverview("project_one"),
  ]);
  let done = false;
  void pending.then(() => { done = true; });

  // The loop is free: a microtask, an immediate and a zero-delay timer all get
  // their turn behind the reads. A synchronous git would have held all three.
  await Promise.resolve();
  await macrotask();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(done).toBe(false);
  // Every one of them is genuinely waiting on git, not finished early.
  expect(git.calls.length).toBeGreaterThan(before);
  expect(git.calls.slice(before)).toContain("rev-parse --is-inside-work-tree");
  expect(() => store.records.get("session_new")).toThrow();
  expect(store.records.get("session_draft").draft).toBeDefined();

  // …and a streaming session's event still lands while they wait.
  store.intake.submitTurn("session_live", { runId: "run_live", input: "still here" });
  expect(store.queries.turns("session_live").map((turn) => turn.runId)).toContain("run_live");

  git.open();
  const [created, cut] = await pending;
  expect(created.workspace).toMatchObject({ mode: "local", baseRef: git.SHA });
  expect(cut.workspace).toMatchObject({ mode: "worktree", baseRef: git.SHA });
  const promoted = store.records.get("session_draft");
  expect(promoted.draft).toBeUndefined();
  expect(promoted.workspace).toMatchObject({ mode: "worktree", baseRef: git.SHA });
});

test("two concurrent identical status reads spawn one git, and the engine's own commit invalidates", async () => {
  const git = gatedGit();
  const store = new EngineStore(root(), () => 1, { asyncGit: git.runner });
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  await store.requestPath.createSession({ id: "session_one", projectId: "project_one", envMode: "local" });
  const statuses = () => git.calls.filter((call) => call.startsWith("status ")).length;

  const start = git.calls.length;
  await Promise.all([store.workspaceReads.sessionDiff("session_one"), store.workspaceReads.sessionDiff("session_one")]);
  const oneRead = git.calls.length - start;
  expect(statuses()).toBe(1);
  // Inside the TTL (the clock does not move): served from the cache.
  await store.workspaceReads.sessionDiff("session_one");
  expect(git.calls.length - start).toBe(oneRead);

  // A write the engine made drops the entry, whatever the clock says.
  await store.sessionGit.commit("session_one", "the engine's own write");
  const afterCommit = git.calls.length;
  await store.workspaceReads.sessionDiff("session_one");
  expect(git.calls.length - afterCommit).toBe(oneRead);
  expect(statuses()).toBe(2);
});

test("browsing many patches releases older cached results", async () => {
  let calls = 0;
  const store = new EngineStore(root(), () => 100, {
    asyncGit: async () => { calls++; return { status: 0, stdout: "", stderr: "" }; },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: root() });
  for (let i = 0; i < 70; i++) await store.workspaceReads.projectFilePatch("project_one", `file-${i}.txt`);
  const before = calls;
  await store.workspaceReads.projectFilePatch("project_one", "file-69.txt");
  expect(calls).toBe(before);
  await store.workspaceReads.projectFilePatch("project_one", "file-0.txt");
  expect(calls).toBeGreaterThan(before);
});
