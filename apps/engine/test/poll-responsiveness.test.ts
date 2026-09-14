import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { defaultAsyncGitRunner, type GitResult } from "../src/worktree";
import { stubModels } from "./stub-models";

const roots: string[] = [];
function root() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "telar-poll-"));
  roots.push(result);
  return result;
}
afterEach(() => { for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });

/** A real repository with one commit — the worktree route's own probes are
 *  synchronous by design (#496) and run against this rather than a fake. */
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
  store.registerProject({ id: "project_one", name: "One", root: root() });
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    expect(store.listProjects()[0]?.id).toBe("project_one");
    expect(store.getProject("project_one").name).toBe("One");
  }
  expect(performance.now() - started).toBeLessThan(200);
  expect(asked).toEqual(["rev-parse --abbrev-ref HEAD", "config --get remote.origin.url"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  finish({ status: 0, stdout: "main\n", stderr: "" });
  for (let i = 0; i < 100 && store.listProjects()[0]?.branch !== "main"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(store.listProjects()[0]?.branch).toBe("main");
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
  store.registerProject({ id: "project_one", name: "One", root: root() });
  const first = store.projectGitAsync("project_one");
  const second = store.projectGitAsync("project_one");
  await Promise.resolve();
  expect(calls).toBe(1);
  finish({ status: 128, stdout: "", stderr: "not a repository" });
  expect(await first).toEqual(await second);
  await store.projectGitAsync("project_one");
  expect(calls).toBe(1);
  now += 2_001;
  await store.projectGitAsync("project_one");
  expect(calls).toBe(2);
});

test("async patch reads retain the project path fence", () => {
  const store = new EngineStore(root());
  store.registerProject({ id: "project_one", name: "One", root: root() });
  expect(() => store.projectFilePatchAsync("project_one", "../../etc/passwd")).toThrow("outside the workspace");
});


test("HTTP health and sidebar requests respond while review Git remains pending", async () => {
  const { startEngine } = await import("../src/daemon");
  let release!: (result: GitResult) => void;
  const stalled = new Promise<GitResult>((resolve) => { release = resolve; });
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), asyncGit: async () => stalled });
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}` };
  daemon.store.registerProject({ id: "project_one", name: "One", root: root() });
  const review = fetch(`${base}/v2/projects/project_one/git`, { headers });
  try {
    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const responses = await Promise.all([
        fetch(`${base}/v2/health`, { headers }),
        fetch(`${base}/v2/projects`, { headers }),
      ]);
      for (const response of responses) { expect(response.ok).toBeTrue(); await response.json(); }
      durations.push(performance.now() - started);
    }
    expect(Math.max(...durations)).toBeLessThan(250);
  } finally {
    release({ status: 128, stdout: "", stderr: "not a repository" });
    await (await review).text();
    await daemon.close();
  }
});

/**
 * #496's whole point, measured: a `git worktree add` that never finishes must
 * not cost an unrelated route a single millisecond.
 *
 * BEFORE THIS CHANGE the cut ran on `execFileSync` inside `POST /v2/sessions`,
 * so the daemon's event loop was held for its entire duration — with the fake
 * below, forever. The route would not have returned at all, and neither would
 * the health and sidebar reads behind it.
 */
test("a stalled worktree add delays neither its own route nor an unrelated one", async () => {
  const { startEngine } = await import("../src/daemon");
  const projectRoot = repo();
  let released!: (result: GitResult) => void;
  const stalled = new Promise<GitResult>((resolve) => { released = resolve; });
  let adds = 0;
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: root(),
    // Only the cut stalls. The request-side probes (`--is-inside-work-tree`,
    // `rev-parse`) are synchronous by design and run against the real repo.
    asyncGit: async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "add") { adds++; return stalled; }
      return defaultAsyncGitRunner(cwd, args, options);
    },
  });
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" };
  daemon.store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  try {
    const startedCreate = performance.now();
    const created = await fetch(`${base}/v2/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "session_one", projectId: "project_one", envMode: "worktree" }),
    });
    const createMs = performance.now() - startedCreate;
    expect(created.status).toBe(201);
    const { session } = await created.json();
    // The route answered with a complete row whose checkout is still being made.
    expect(session.preparation).toMatchObject({ state: "preparing" });
    expect(session.workspace.branch).toBe("telar/session_one");
    expect(createMs).toBeLessThan(250);

    // …and the loop stayed free while the cut hangs.
    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const responses = await Promise.all([
        fetch(`${base}/v2/health`, { headers }),
        fetch(`${base}/v2/sessions/live`, { headers }),
      ]);
      for (const response of responses) { expect(response.ok).toBeTrue(); await response.json(); }
      durations.push(performance.now() - started);
    }
    expect(Math.max(...durations)).toBeLessThan(250);
    // The stall was real: the cut was actually attempted and is still pending.
    expect(adds).toBe(1);
    expect(daemon.store.getSession("session_one").preparation?.state).toBe("preparing");
  } finally {
    released({ status: 0, stdout: "", stderr: "" });
    await daemon.close();
  }
});

test("browsing many patches releases older cached results", async () => {
  let calls = 0;
  const store = new EngineStore(root(), () => 100, {
    asyncGit: async () => { calls++; return { status: 0, stdout: "", stderr: "" }; },
  });
  store.registerProject({ id: "project_one", name: "One", root: root() });
  for (let i = 0; i < 70; i++) await store.projectFilePatchAsync("project_one", `file-${i}.txt`);
  const before = calls;
  await store.projectFilePatchAsync("project_one", "file-69.txt");
  expect(calls).toBe(before);
  await store.projectFilePatchAsync("project_one", "file-0.txt");
  expect(calls).toBeGreaterThan(before);
});
