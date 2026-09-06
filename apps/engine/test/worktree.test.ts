/**
 * Stage 7 — worktree sessions.
 *
 * The property under test is the precondition for running several detached
 * sessions on one project: each gets a checkout of its own, and the work it
 * produces survives the session ending.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";
import { createAsyncGitRunner, defaultAsyncGitRunner, createGitRunner, createSessionWorktree, DEFAULT_GIT_TIMEOUT_MS, defaultGitRunner, GIT_TIMEOUT_STATUS, removeSessionWorktree, WorktreeError, type GitRunner } from "../src/worktree";
import { gitOverview, gitOverviewAsync, sessionDiff, sessionDiffAsync, sessionFilePatch, sessionFilePatchAsync } from "../src/git";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository with one commit, so `HEAD` resolves. */
function repo(): string {
  const root = tmp("telar-wt-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

test("a worktree session gets its own checkout on a named branch", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "session_one" });

  expect(fs.existsSync(path.join(cut.path, "README.md"))).toBe(true);
  expect(cut.branch).toBe("telar/session_one");
  // ON A BRANCH, NOT DETACHED. A detached worktree's commits become
  // unreachable the moment it is removed, and a detached session's whole
  // output is its commits.
  const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cut.path, encoding: "utf8" }).trim();
  expect(head).toBe("telar/session_one");
  // Inside the engine's own root, never a sibling of core's `worktrees`.
  expect(cut.path.startsWith(path.join(engineRoot, "worktrees"))).toBe(true);
});

test("two sessions on one project get separate checkouts", () => {
  // The whole point: N detached sessions must not fight over one working copy.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" });
  const second = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "two" });
  expect(first.path).not.toBe(second.path);
  expect(first.branch).not.toBe(second.branch);

  fs.writeFileSync(path.join(first.path, "only-in-one.txt"), "x");
  expect(fs.existsSync(path.join(second.path, "only-in-one.txt"))).toBe(false);
});

test("a non-git project is refused with an actionable message rather than a git error", () => {
  const projectRoot = tmp("telar-wt-plain-");
  const engineRoot = tmp("telar-wt-state-");
  expect(() => createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" })).toThrow(WorktreeError);
  expect(() => createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" })).toThrow(/envMode "local"/);
});

test("recreating a session's worktree after a reap succeeds instead of failing on the branch name", () => {
  // `-B` rather than `-b`. With `-b`, a session whose worktree was reaped could
  // never be recreated: the branch still exists and git refuses.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" });
  expect(removeSessionWorktree(defaultGitRunner, projectRoot, first.path)).toBe(true);
  const again = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" });
  expect(fs.existsSync(again.path)).toBe(true);
});

test("removal reports whether the directory is ACTUALLY gone", () => {
  // The caller's only reliable signal: a failed `git worktree remove` comes
  // back as a non-zero status rather than an exception, and the trailing
  // prune would otherwise hide it.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" });
  expect(removeSessionWorktree(defaultGitRunner, projectRoot, cut.path)).toBe(true);

  const deaf: GitRunner = () => ({ status: 1, stdout: "", stderr: "nope" });
  const stubborn = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "two" });
  expect(removeSessionWorktree(deaf, projectRoot, stubborn.path)).toBe(false);
});

test("a branch slug names the branch and the directory after the work", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = createSessionWorktree(defaultGitRunner, {
    engineRoot,
    projectRoot,
    sessionId: "session_one",
    branchSlug: "loom/hito1-agosto/presupuestos",
  });
  expect(cut.branch).toBe("loom/hito1-agosto/presupuestos");
  // The directory drops the namespace prefix — a human scanning the worktrees
  // folder reads loom and thread, not machinery.
  expect(path.basename(cut.path)).toMatch(/^hito1-agosto--presupuestos-[0-9a-f]{8}$/);
});

test("a branch slug outside the engine-owned namespaces is refused", () => {
  // `-B` resets an existing branch; that is only safe where humans do not
  // branch. `main` through this path would be catastrophic.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  for (const slug of ["main", "feature/login", "loom", "loom//x"]) {
    expect(() => createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "s", branchSlug: slug })).toThrow(
      WorktreeError,
    );
  }
});

test("a titled worktree session derives its branch from the title", () => {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({
    id: "session_abcdef123456",
    projectId: "project_one",
    title: "Fix «Presupuestos» login!",
    envMode: "worktree",
  });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  expect(session.workspace.branch).toBe("telar/fix-presupuestos-login-abcdef");
});

test("a session created with envMode worktree records its branch and base", () => {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });

  expect(session.envMode).toBe("worktree");
  expect(session.workspace).toMatchObject({ mode: "worktree", branch: "telar/session_one" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  expect(session.workspace.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(fs.existsSync(session.workspace.path)).toBe(true);

  // The claim hands the worker the SESSION's checkout, not the project root —
  // otherwise the isolation is cosmetic.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")?.projectRoot).toBe(session.workspace.path);
});

test("the standing default decides an omitted envMode, and an explicit one still wins", () => {
  // THE SETTING IS A REAL DEFAULT, not a pre-ticked box in the composer: a
  // caller that says nothing — the MCP toolkit, an API client — builds what the
  // preference says.
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.setSessionDefaults({ envMode: "worktree" });

  const silent = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(silent.envMode).toBe("worktree");
  expect(silent.workspace.mode).toBe("worktree");

  // A caller who ASKED for the shared checkout gets it regardless.
  const asked = store.createSession({ id: "session_two", projectId: "project_one", envMode: "local" });
  expect(asked.envMode).toBe("local");
});

test("the worktree default yields on an unversioned project, but a stated worktree still throws", () => {
  // `createSessionWorktree` refuses a directory that is not a repo — right for
  // a caller who asked for a worktree, and wrong for one who asked for nothing
  // and would otherwise be unable to open a session in that project at all.
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: tmp("telar-wt-plain-") });
  store.setSessionDefaults({ envMode: "worktree" });

  const silent = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(silent.envMode).toBe("local");

  expect(() => store.createSession({ id: "session_two", projectId: "project_one", envMode: "worktree" })).toThrow(WorktreeError);
});

test("a failed worktree cut leaves no half-created session behind", () => {
  // The worktree is cut BEFORE the session document is written, so there is
  // nothing to repair on read.
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: tmp("telar-wt-plain-") });
  expect(() => store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" })).toThrow(WorktreeError);
  expect(() => store.getSession("session_one")).toThrow(EngineStateError);
});

test("archiving frees the checkout and KEEPS the branch", () => {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");

  // Work the session produced.
  execFileSync("git", ["commit", "-qm", "session work", "--allow-empty"], { cwd: session.workspace.path });

  const archived = store.archiveSession("session_one");
  expect(archived.state).toBe("archived");
  expect(fs.existsSync(session.workspace.path)).toBe(false);
  // THE BRANCH SURVIVES. A detached run whose output vanished when it finished
  // would be worse than one that never ran.
  const branches = execFileSync("git", ["branch", "--list", "telar/session_one"], { cwd: projectRoot, encoding: "utf8" });
  expect(branches.trim()).toContain("telar/session_one");
  expect(store.readEvents("session_one").at(-1)?.type).toBe("session.archived");
});

test("archiving refuses while a turn is in flight", () => {
  // Pulling the checkout out from under a live provider process is how a
  // half-written file becomes a corrupt commit.
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.archiveSession("session_one")).toThrow(/active turn/);

  store.stopTurn("session_one", "run_one");
  expect(store.archiveSession("session_one").state).toBe("archived");
});

test("archiving is idempotent", () => {
  const store = new EngineStore(tmp("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.readEvents("session_one").filter((event) => event.type === "session.archived")).toHaveLength(1);
});

test("a worktree cut from a NAMED base starts at that commit, not HEAD", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const baseSha = git("rev-parse", "HEAD").trim();
  git("branch", "feature-x");
  // HEAD moves on; feature-x stays at the first commit.
  fs.writeFileSync(path.join(projectRoot, "later.md"), "later\n");
  git("add", "-A");
  git("commit", "-qm", "second");

  const cut = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "s", baseRef: "feature-x" });
  expect(cut.baseRef).toBe(baseSha);
  expect(fs.existsSync(path.join(cut.path, "later.md"))).toBe(false);
});

test("a HUMAN-named branch is created with -b: a collision refuses, never resets", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one", branchName: "my-feature" });
  expect(first.branch).toBe("my-feature");
  // The same name again must refuse — a branch a person values is never reset.
  expect(() => createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "two", branchName: "my-feature" })).toThrow(
    WorktreeError,
  );
});

test("human branch names refuse the engine namespaces and unusable shapes", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  for (const bad of ["telar/mine", "loom/x", "-flag", "a..b", "a//b", "ends/"]) {
    expect(() => createSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "s", branchName: bad })).toThrow(WorktreeError);
  }
});

test("the overview lists cuttable refs: locals and remote-tracking, current marked, no origin/HEAD", () => {
  const projectRoot = repo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("branch", "feature-x");
  // A remote-tracking ref without a network: write the ref directly.
  const sha = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", sha);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  const overview = gitOverview(defaultGitRunner, projectRoot);
  const names = (overview.refs ?? []).map((ref) => `${ref.kind}:${ref.name}`);
  expect(names).toContain("local:main");
  expect(names).toContain("local:feature-x");
  expect(names).toContain("remote:origin/main");
  // origin/HEAD is a pointer, not a branch.
  expect(names.some((name) => name.endsWith("/HEAD"))).toBe(false);
  // The checkout's branch is marked, so a picker can say "current".
  expect((overview.refs ?? []).find((ref) => ref.name === "main")?.head).toBe(true);
  // origin/HEAD names the default base a fresh worktree is cut from.
  expect(overview.defaultBase).toBe("origin/main");
});

test("the default base falls back to common names, and is absent without remote state", () => {
  const projectRoot = repo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // No remote-tracking refs at all: nothing to default to.
  expect(gitOverview(defaultGitRunner, projectRoot).defaultBase).toBeUndefined();

  // A hand-added remote has refs but no origin/HEAD pointer — the common
  // names are the fallback.
  const sha = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/master", sha);
  expect(gitOverview(defaultGitRunner, projectRoot).defaultBase).toBe("origin/master");
  git("update-ref", "refs/remotes/origin/main", sha);
  expect(gitOverview(defaultGitRunner, projectRoot).defaultBase).toBe("origin/main");

  // A pointer to a branch that no longer exists must not be trusted — every
  // worktree cut from it would fail its rev-parse.
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
  expect(gitOverview(defaultGitRunner, projectRoot).defaultBase).toBe("origin/main");
});

/**
 * A fake `git` that never returns. Writes its pid first so the test can prove
 * the child is GONE, not merely abandoned: a runner that gave up waiting but
 * left the process behind would still leak a stuck git per poll.
 */
function stalledGit(): { bin: string; pidFile: string } {
  const dir = tmp("telar-stalled-git-");
  const pidFile = path.join(dir, "pid");
  const bin = path.join(dir, "git");
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`, { mode: 0o755 });
  return { bin, pidFile };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a git child that stalls is killed at the bound and reported, not waited on forever", () => {
  // Measured: `git rev-parse --abbrev-ref HEAD` blocked for minutes in the
  // kernel under ~/Documents, and the synchronous runner blocked the daemon's
  // whole event loop with it — every project list timed out until the process
  // was killed by hand. The runner now does that itself.
  const { bin, pidFile } = stalledGit();
  // Long enough for the fake to START under a loaded test run (the pid write
  // is its first line) — a shorter bound killed it before it wrote anything.
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 1_500 });
  const started = Date.now();
  const result = git("/tmp", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.timedOut).toBe(true);
  expect(result.status).toBe(GIT_TIMEOUT_STATUS);
  expect(result.stderr).toContain("did not finish within 1500ms");
  // The child itself, not just the wait: execFileSync reaps what it kills.
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(false);
});

test("a per-call bound wins over the runner's default", () => {
  const { bin } = stalledGit();
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 60_000 });
  const started = Date.now();
  expect(git("/tmp", ["status"], { timeoutMs: 200 }).timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("an ordinary failure is still an ordinary failure, and the default runner is bounded", () => {
  const unversioned = tmp("telar-not-a-repo-");
  const result = defaultGitRunner(unversioned, ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.status).not.toBe(0);
  expect(result.timedOut).toBeUndefined();
  expect(result.stderr).toContain("not a git repository");
  expect(DEFAULT_GIT_TIMEOUT_MS).toBeGreaterThan(0);
});


test("async git deadlines do not block timers and missing binaries return failures", async () => {
  const run = createAsyncGitRunner({ gitBin: process.execPath, defaultTimeoutMs: 150 });
  let heartbeat = false;
  const tick = setTimeout(() => { heartbeat = true; }, 10);
  const result = await run(process.cwd(), ["-e", "setTimeout(() => {}, 60000)"]);
  clearTimeout(tick);
  expect(heartbeat).toBe(true);
  expect(result.status).toBe(GIT_TIMEOUT_STATUS);
  expect(result.timedOut).toBe(true);
  const missing = await createAsyncGitRunner({ gitBin: "/nonexistent/telar-git" })(process.cwd(), []);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).not.toBe("");
});

test("async git pool expires queued reads without spawning them and recovers capacity", async () => {
  const root = tmp("telar-git-pool-");
  const marker = path.join(root, "should-not-run");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const stalled = run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 250 });
  const queued = run(root, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { timeoutMs: 50 });
  expect((await queued).timedOut).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
  expect((await stalled).timedOut).toBe(true);
  const recovered = await run(root, ["-e", "process.stdout.write('ready')"], { timeoutMs: 2000 });
  expect(recovered).toEqual({ status: 0, stdout: "ready", stderr: "" });
  expect(fs.existsSync(marker)).toBe(false);
});

test("async git reads preserve overview and review data for committed and untracked changes", async () => {
  const root = repo();
  const base = defaultGitRunner(root, ["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(root, "README.md"), "hello\ncommitted\n");
  defaultGitRunner(root, ["commit", "-am", "second"]);
  fs.writeFileSync(path.join(root, "README.md"), "hello\ncommitted\nworking\n");
  fs.writeFileSync(path.join(root, "new.txt"), "new file\n");
  const input = { cwd: root, baseRef: base };
  expect(await gitOverviewAsync(defaultAsyncGitRunner, root)).toEqual(gitOverview(defaultGitRunner, root));
  const diff = await sessionDiffAsync(defaultAsyncGitRunner, input);
  expect(diff).toEqual(sessionDiff(defaultGitRunner, input));
  expect(diff.commits).toHaveLength(1);
  expect(diff.files.map(file => file.path)).toEqual(["new.txt", "README.md"].sort((a, b) => a.localeCompare(b)));
  for (const patchInput of [
    { ...input, path: "README.md" },
    { ...input, path: "new.txt", untracked: true },
    { ...input, baseRef: "deleted-base", path: "README.md" },
  ]) {
    const patch = await sessionFilePatchAsync(defaultAsyncGitRunner, patchInput);
    expect(patch).toEqual(sessionFilePatch(defaultGitRunner, patchInput));
    expect(patch.patch).not.toBe("");
  }
});
