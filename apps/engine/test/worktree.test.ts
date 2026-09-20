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
import { worktreeReady } from "./worktree-ready";
import { createAsyncGitRunner, defaultAsyncGitRunner, createGitRunner, createSessionWorktreeAsync, createWorktreeQueue, DEFAULT_GIT_ADMISSION_MS, DEFAULT_GIT_TIMEOUT_MS, defaultGitRunner, GIT_TIMEOUT_STATUS, lockSessionWorktree, prepareSessionWorktree, removeSessionWorktreeAsync, repairWorktree, WORKTREE_ADD_TIMEOUT_MS, WORKTREE_ADMISSION_MS, WorktreeError, worktreeLockReason, defaultWorktreesRoot, type AsyncGitRunner, type GitRunner } from "../src/worktree";
import { gitOverview, gitOverviewAsync, sessionDiff, sessionDiffAsync, sessionFilePatch, sessionFilePatchAsync } from "../src/git";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
const engineHome = (prefix: string): string => {
  const directory = tmp(prefix);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * A POOL OF THIS FILE'S OWN, never `defaultAsyncGitRunner`.
 *
 * The shared singleton has four slots and every suite in this process draws on
 * them — which is exactly what the parity test below says it will not couple
 * itself to. Cuts are the slowest children this file spawns, so borrowing the
 * singleton for them would make an unrelated suite's reads wait on a
 * `worktree add`, and this file's own cuts wait on whatever that suite is
 * doing. Measured as ~5s timeouts across this file under a full run.
 */
const poolGit = createAsyncGitRunner();

/**
 * The whole cut, the way `createSession` makes it: refuse on the request, then
 * do the expensive half asynchronously (#496). Composed here rather than in the
 * source because the store is the only caller that needs the two halves apart —
 * a test asserting on a finished checkout wants one call.
 */
async function cutWorktree(input: {
  engineRoot: string;
  projectRoot: string;
  sessionId: string;
  baseRef?: string;
  branchSlug?: string;
  branchName?: string;
}): Promise<{ path: string; branch: string; baseRef: string }> {
  const { plan, baseSha } = prepareSessionWorktree(defaultGitRunner, input);
  return createSessionWorktreeAsync(poolGit, {
    engineRoot: input.engineRoot,
    projectRoot: input.projectRoot,
    plan,
    baseSha,
  });
}

/**
 * Wait for a session's background cut to land — the seam #496 introduced.
 *
 * THE SHARED ONE, not a local copy (#706). This file used to carry its own
 * identical loop with its own two-second ceiling, which is precisely the drift
 * `worktree-ready.ts` exists to prevent — and it was that copy, not the shared
 * helper, that failed under full-suite load. The alias keeps the local name.
 */
const settled = worktreeReady;

/**
 * Poll `done` until it holds or `boundMs` elapses; report which.
 *
 * A FIXTURE'S STARTUP MUST NOT SHARE THE DEADLINE BEING MEASURED — #748's
 * lesson, applied to the process-tree tests below. A child that writes its pid
 * before a runner's 500 ms timeout fires leaves the test measuring the runner;
 * a child that does not leaves it measuring `bun`'s cold start, and the failure
 * arrives as `ENOENT` on a pid file rather than as anything about the bound.
 * Observed exactly once, on the first run after a source change — which is the
 * run a cold transpile makes slowest.
 */
const until = async (done: () => boolean, boundMs: number): Promise<boolean> => {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline && !done()) await new Promise(resolve => setTimeout(resolve, 25));
  return done();
};

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

test("a worktree session gets its own checkout on a named branch", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "session_one" });

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

test("two sessions on one project get separate checkouts", async () => {
  // The whole point: N detached sessions must not fight over one working copy.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  const second = await cutWorktree({ engineRoot, projectRoot, sessionId: "two" });
  expect(first.path).not.toBe(second.path);
  expect(first.branch).not.toBe(second.branch);

  fs.writeFileSync(path.join(first.path, "only-in-one.txt"), "x");
  expect(fs.existsSync(path.join(second.path, "only-in-one.txt"))).toBe(false);
});

test("a non-git project is refused with an actionable message rather than a git error", () => {
  const projectRoot = tmp("telar-wt-plain-");
  const engineRoot = tmp("telar-wt-state-");
  // ON THE REQUEST, not on the row: a directory that cannot host a worktree is
  // a bad request, and #496 deliberately left those refusals synchronous.
  expect(() => prepareSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" })).toThrow(WorktreeError);
  expect(() => prepareSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "one" })).toThrow(/envMode "local"/);
});

test("recreating a session's worktree after a reap succeeds instead of failing on the branch name", async () => {
  // `-B` rather than `-b`. With `-b`, a session whose worktree was reaped could
  // never be recreated: the branch still exists and git refuses.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, first.path)).toBe(true);
  const again = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  expect(fs.existsSync(again.path)).toBe(true);
});

test("removal reports whether the directory is ACTUALLY gone", async () => {
  // The caller's only reliable signal: a failed `git worktree remove` comes
  // back as a non-zero status rather than an exception, and the trailing
  // prune would otherwise hide it.
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, cut.path)).toBe(true);

  const deaf: AsyncGitRunner = async () => ({ status: 1, stdout: "", stderr: "nope" });
  const stubborn = await cutWorktree({ engineRoot, projectRoot, sessionId: "two" });
  expect(await removeSessionWorktreeAsync(deaf, projectRoot, stubborn.path)).toBe(false);
});

/**
 * ══ THE STORE CAN BE ON A DRIVE NOW — issue #630 ══
 *
 * These four pin the case the original guard does not cover. It asks whether
 * the PROJECT is readable; once the engine root can be on a volume, a project
 * on the internal disk can be perfectly available while the worktrees are on a
 * drive that is out — and `prune` would then delete the registration of every
 * worktree on it, not just the one being removed.
 */
test("prune never runs when the worktrees root is gone, however available the project is", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // The drive goes: the worktrees root and everything under it is absent. The
  // PROJECT is untouched and reads as available, which is the whole trap.
  fs.rmSync(defaultWorktreesRoot(engineRoot), { recursive: true, force: true });

  let ran: string[][] = [];
  const watched: AsyncGitRunner = async (cwd, args) => {
    ran.push(args);
    return poolGit(cwd, args);
  };
  expect(await removeSessionWorktreeAsync(watched, projectRoot, cut.path, "available")).toBe(false);
  // Not "it pruned and the registration happened to survive" — it never asked.
  expect(ran.some((args) => args.includes("prune"))).toBe(false);

  // And git still knows about it, which is the thing worth protecting: the work
  // is on the drive in somebody's bag and the registration is how it comes back.
  const listed = execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" });
  expect(listed).toContain(path.basename(cut.path));
});

/**
 * ══ AND THE LOCK IS ABOUT THE SESSION, NOT THE DISK — issue #641 ══
 *
 * #630 locked only worktrees on a removable volume. What actually destroyed
 * them was `gh pr merge --delete-branch`, which removes whichever linked
 * worktree holds the merged branch — a command aimed at a pull request, landing
 * on a checkout a session is still working in.
 */
test("every session worktree is locked the moment it exists, on any disk", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // Not "the lock command was issued" — what git itself says about the tree.
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
  const record = listed.split("\n\n").find((block) => block.includes(cut.path));
  expect(record).toBeDefined();
  expect(record).toContain("locked");
  // The reason is what a person meets in `git worktree list` and in gh's
  // refusal, so it has to name the session rather than the volume.
  expect(record).toContain("archived or deleted");
});

test("the lock reason names the volume only when there is one", () => {
  expect(worktreeLockReason("/Users/someone/Telar/engine/worktrees/x", "darwin")).not.toContain("removable volume");
  // A real mount point cannot be faked here, so this pins the other half: an
  // ordinary path never picks up #630's sentence.
  expect(worktreeLockReason("/Users/someone/Telar/engine/worktrees/x", "darwin")).toContain("A Telar session is working in this worktree");
});

/**
 * THE REGRESSION TEST FOR #641, written as the command that did it.
 *
 * `git worktree remove -- <path>` with no force is gh 2.100.0's exact call
 * (`git/client.go`'s `WorktreeRemove`, reached from `deleteLocalBranch`'s
 * "another linked worktree" arm). A single `--force` is here too because that is
 * the obvious next thing anyone reaches for, and git still refuses it — only
 * `-f -f` overrides a lock, which gh never passes.
 */
test("gh's own worktree removal cannot take a live session's checkout", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  fs.writeFileSync(path.join(cut.path, "half-finished.txt"), "the work that is not committed yet\n");

  const attempt = (...args: string[]): number => {
    try {
      execFileSync("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  expect(attempt("worktree", "remove", "--", cut.path)).not.toBe(0);
  expect(attempt("worktree", "remove", "--force", "--", cut.path)).not.toBe(0);
  expect(fs.existsSync(path.join(cut.path, "half-finished.txt"))).toBe(true);

  // And the registration survives a prune, which is the half that cannot be
  // recovered once it is gone.
  execFileSync("git", ["worktree", "prune"], { cwd: projectRoot });
  expect(execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" })).toContain(path.basename(cut.path));
});

test("a lock does not get in the way of the session's own work", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // The point of the worktree is that a session can commit in it. A guard that
  // bought safety by breaking that would not be worth having.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: cut.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(cut.path, "work.txt"), "done\n");
  git("add", "-A");
  git("-c", "user.email=test@telar.local", "-c", "user.name=Telar Test", "commit", "-qm", "work");
  expect(git("log", "--oneline", "-1")).toContain("work");
  // `repair` is lock-transparent too, which is what keeps #630's store move
  // working now that every worktree is locked rather than only some.
  expect(await repairWorktree(poolGit, projectRoot, cut.path)).toBe(true);
});

test("an already-locked worktree is not a failure to lock again", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  // The cut already locked it; the startup backfill locks every live worktree
  // on every boot, so the second call is the ordinary case rather than an edge.
  await lockSessionWorktree(poolGit, projectRoot, cut.path);
  expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" })).toContain("locked");
  // And it still comes apart on the one path that is allowed to take it.
  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, cut.path, "available")).toBe(true);
});

test("a locked worktree is still removable, because teardown unlocks first", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  // The cut locks it — every worktree since #641, not only the ones on a drive —
  // and git refuses `worktree remove` on a locked tree. So this is the state
  // teardown always meets, rather than the unusual one it used to be.
  expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" })).toContain("locked");

  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, cut.path, "available")).toBe(true);
  expect(fs.existsSync(cut.path)).toBe(false);
});

test("repair re-points git at a worktree that moved, which a byte copy never does", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const moved = tmp("telar-wt-moved-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // What the migration does: the directory is copied somewhere else and the
  // original goes away. The worktree's own .git still resolves — it names the
  // REPOSITORY, which did not move — but the repository's pointer back at the
  // worktree names a path that is now gone.
  const destination = path.join(moved, path.basename(cut.path));
  fs.cpSync(cut.path, destination, { recursive: true });
  fs.rmSync(cut.path, { recursive: true, force: true });
  expect(execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" })).toContain(cut.path);

  expect(await repairWorktree(poolGit, projectRoot, destination)).toBe(true);
  const listed = execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" });
  expect(listed).toContain(destination);
  expect(listed).not.toContain(`${cut.path} `);
});

test("a branch slug names the branch and the directory after the work", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({
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
    expect(() => prepareSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "s", branchSlug: slug })).toThrow(
      WorktreeError,
    );
  }
});

test("a titled worktree session derives its branch from the title", () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
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

test("a session created with envMode worktree records its branch and base", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });

  expect(session.envMode).toBe("worktree");
  // THE ROW IS COMPLETE BEFORE THE DIRECTORY IS (#496): the branch and the base
  // are decided on the request, so the rail never shows a session whose most
  // stable identifier is missing for a few seconds.
  expect(session.workspace).toMatchObject({ mode: "worktree", branch: "telar/session_one" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  expect(session.workspace.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(session.preparation).toEqual({ state: "preparing", at: 100 });

  await settled(store, "session_one");
  expect(store.getSession("session_one").preparation).toBeUndefined();
  expect(fs.existsSync(session.workspace.path)).toBe(true);

  // The claim hands the worker the SESSION's checkout, not the project root —
  // otherwise the isolation is cosmetic.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")?.projectRoot).toBe(session.workspace.path);
});

test("a turn does not dispatch until the checkout it would run in exists", async () => {
  // The cut is asynchronous now, so an agent can create a session and send to
  // it in the same breath. Dispatching then would set a provider process's cwd
  // to a directory nothing has made yet.
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")).toBeUndefined();
  expect(store.claimTurn("session_one", "worker_one")).toBeUndefined();

  // The message kept its place rather than being dropped, and runs once the
  // checkout lands.
  await settled(store, "session_one");
  expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
});

test("a cut that fails flips the row to failed, with git's own words on it", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100, {
    // The request-side probes still run for real; only `worktree add` is faked.
    asyncGit: async (cwd, args) =>
      args[0] === "worktree" && args[1] === "add"
        ? { status: 128, stdout: "", stderr: "fatal: Unable to create '.git/index.lock': File exists" }
        : defaultAsyncGitRunner(cwd, args),
  });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });

  await settled(store, "session_one");
  const failed = store.getSession("session_one").preparation;
  expect(failed?.state).toBe("failed");
  // GIT'S OWN STDERR, not a rewrite: the person reading the row is the one who
  // can act on a stale lock, and our sentence for it would say less.
  expect(failed?.error).toContain("index.lock");
  // And nothing runs in a checkout that was never made.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")).toBeUndefined();
});

test("the standing default decides an omitted envMode, and an explicit one still wins", () => {
  // THE SETTING IS A REAL DEFAULT, not a pre-ticked box in the composer: a
  // caller that says nothing — the MCP toolkit, an API client — builds what the
  // preference says.
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.setSessionDefaults({ envMode: "worktree" });

  const silent = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(silent.envMode).toBe("worktree");
  expect(silent.workspace.mode).toBe("worktree");

  // A caller who ASKED for the shared checkout gets it regardless.
  const asked = store.createSession({ id: "session_two", projectId: "project_one", envMode: "local" });
  expect(asked.envMode).toBe("local");
});

test("a local session's diff says the checkout is shared, and a worktree session's does not (#690)", async () => {
  /**
   * `base…worktree` is "what this session did" only in a checkout nobody else
   * writes to. A local session shares the project's, so a conversation that
   * wrote no code was shown ninety-two files as its own work. The flag is what
   * lets the surface say which question it answered; the figures are the same
   * either way.
   */
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });

  // Somebody else's uncommitted work, already in the tree before either session.
  fs.writeFileSync(path.join(projectRoot, "README.md"), "hello\nsomebody else\n");

  store.createSession({ id: "session_local", projectId: "project_one", envMode: "local" });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await settled(store, "session_cut");

  const local = store.sessionDiff("session_local");
  expect(local.shared).toBe(true);
  // The flag withdraws a CLAIM, not the reading: the row is still there.
  expect(local.files.map((entry) => entry.path)).toEqual(["README.md"]);
  expect(store.sessionDiff("session_cut").shared).toBeUndefined();

  // The async reader, which is what every client actually calls, agrees.
  expect((await store.sessionDiffAsync("session_local")).shared).toBe(true);
  expect((await store.sessionDiffAsync("session_cut")).shared).toBeUndefined();
  // And a project diff has no session to misattribute anything to.
  expect(store.projectDiff("project_one").shared).toBeUndefined();
});

test("the worktree default yields on an unversioned project, but a stated worktree still throws", () => {
  // `prepareSessionWorktree` refuses a directory that is not a repo — right for
  // a caller who asked for a worktree, and wrong for one who asked for nothing
  // and would otherwise be unable to open a session in that project at all.
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: tmp("telar-wt-plain-") });
  store.setSessionDefaults({ envMode: "worktree" });

  const silent = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(silent.envMode).toBe("local");

  expect(() => store.createSession({ id: "session_two", projectId: "project_one", envMode: "worktree" })).toThrow(WorktreeError);
});

test("a refused worktree request leaves no half-created session behind", () => {
  // The REFUSALS still happen before the session document is written (#496), so
  // a bad request leaves nothing to repair on read. What moved to the
  // background is only the cut itself, whose failure lands on the row.
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: tmp("telar-wt-plain-") });
  expect(() => store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" })).toThrow(WorktreeError);
  expect(() => store.getSession("session_one")).toThrow(EngineStateError);
});

test("archiving frees the checkout and KEEPS the branch", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  await settled(store, "session_one");

  // Work the session produced.
  execFileSync("git", ["commit", "-qm", "session work", "--allow-empty"], { cwd: session.workspace.path });

  const archived = store.archiveSession("session_one");
  expect(archived.state).toBe("archived");
  // The removal runs on the same per-project queue the cut did, so it is not
  // done the instant `archiveSession` returns — see `releaseWorktree`.
  for (let i = 0; i < 400 && fs.existsSync(session.workspace.path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.archiveSession("session_one")).toThrow(/active turn/);

  store.stopTurn("session_one", "run_one");
  expect(store.archiveSession("session_one").state).toBe("archived");
});

test("archiving is idempotent", () => {
  const store = new EngineStore(engineHome("telar-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.readEvents("session_one").filter((event) => event.type === "session.archived")).toHaveLength(1);
});

test("a worktree cut from a NAMED base starts at that commit, not HEAD", async () => {
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

  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "s", baseRef: "feature-x" });
  expect(cut.baseRef).toBe(baseSha);
  expect(fs.existsSync(path.join(cut.path, "later.md"))).toBe(false);
});

test("a HUMAN-named branch is created with -b: a collision refuses, never resets", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const first = await cutWorktree({ engineRoot, projectRoot, sessionId: "one", branchName: "my-feature" });
  expect(first.branch).toBe("my-feature");
  // The same name again must refuse — a branch a person values is never reset.
  // GIT is what refuses here rather than a name check, so this one surfaces
  // from the background half and reaches a session row as `failed`.
  await expect(cutWorktree({ engineRoot, projectRoot, sessionId: "two", branchName: "my-feature" })).rejects.toThrow(
    WorktreeError,
  );
});

test("human branch names refuse the engine namespaces and unusable shapes", () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  for (const bad of ["telar/mine", "loom/x", "-flag", "a..b", "a//b", "ends/"]) {
    expect(() => prepareSessionWorktree(defaultGitRunner, { engineRoot, projectRoot, sessionId: "s", branchName: bad })).toThrow(WorktreeError);
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
  /**
   * ASSERTED FIRST, so a loaded machine says what happened — issue #650.
   *
   * This ran real `for-each-ref` children and failed roughly one run in four
   * with `Expected to contain: "local:main" / Received: [ "remote:origin/main" ]`
   * — a message that reads like the listing is wrong when what happened is that
   * git was killed at its bound. The engine can now tell those apart, so the
   * test does too: an incomplete listing is a stalled machine, not a regression
   * in what this test is about.
   */
  expect(overview.refsIncomplete).toBeUndefined();
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
 * A fake `git` that never returns. It writes nothing and needs no cooperation
 * from the test: the runner reports the pid it killed, so proving the child is
 * GONE rather than merely abandoned no longer depends on the child having got
 * far enough to say who it was (#748).
 *
 * `exec` IS LOAD-BEARING, AND THE ASSERTION BELOW RELIES ON IT. `sh` replaces
 * itself with `sleep`, so there is exactly one process and its pid is the one
 * the runner spawned. SIGKILL reaps git; it does not reap what git SPAWNED
 * (#743, measured: a clean filter outlived the git that started it by 5.6 s), so
 * a fixture that forked instead of exec'ing would leave a grandchild this check
 * cannot see and would prove less than it appears to.
 */
function stalledGit(): { bin: string } {
  const dir = tmp("telar-stalled-git-");
  const bin = path.join(dir, "git");
  fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
  return { bin };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * TWO CLAIMS, TWO TESTS, AND THEY USED TO SHARE ONE NUMBER (#748).
 *
 * Measured: `git rev-parse --abbrev-ref HEAD` blocked for minutes in the kernel
 * under ~/Documents, and the synchronous runner blocked the daemon's whole event
 * loop with it — every project list timed out until the process was killed by
 * hand. The runner now does that itself, and there are two separate things to
 * check about it: that it REPORTS a timeout at its bound, and that the child is
 * actually dead.
 *
 * `defaultTimeoutMs: 1_500` used to serve both, and only the first was under
 * test. The second needed the fixture to have written its pid to a file, which
 * it could only do if `sh` reached its first line inside the same 1,500 ms the
 * bound was measuring — so the test passed at 1503.34 ms and failed at
 * 1507.28 ms four minutes later, and the `ENOENT` meant the shell had never
 * started at all rather than that a write was lost. Raising the number had
 * already been tried once; it made the race rarer and left it in place.
 *
 * Nothing here is unsynchronised any more, and not because the numbers are
 * bigger: there is no file, so there is nothing for the bound to race. The pid
 * comes back from the runner, which has it because it did the spawn.
 */
test("a git child that stalls is reported as timed out at its bound, not waited on forever", () => {
  const { bin } = stalledGit();
  // 250 ms, where it used to be 1,500: nothing in this test depends on the child
  // having reached its first line, because the bound is on the PARENT's wait.
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 250 });
  const started = Date.now();
  const result = git("/tmp", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.timedOut).toBe(true);
  expect(result.status).toBe(GIT_TIMEOUT_STATUS);
  expect(result.stderr).toContain("did not finish within 250ms");
  // The fake sleeps for ten minutes, so this bounds a hang rather than measuring
  // the bound: twenty times the budget, compared against nothing (#706).
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("and the child itself is killed, not left behind once the runner has given up", () => {
  const { bin } = stalledGit();
  // Generously bounded ON PURPOSE. This test's claim is about a process being
  // gone, not about when — so the wait costs nothing here, where in the old
  // single test every extra millisecond was also a millisecond the assertion
  // about the bound had to tolerate.
  const git = createGitRunner({ gitBin: bin, defaultTimeoutMs: 2_000 });
  const result = git("/tmp", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result.timedOut).toBe(true);
  // Reported by the runner, which spawned it — not written by the child, which
  // may never have run a line. `spawnSync` reaps what it kills before returning,
  // so by here the process is either gone or was never anything to begin with.
  const killed = result.killedPid;
  expect(killed).toBeGreaterThan(0);
  expect(alive(killed as number)).toBe(false);
  // And the pid is in the message, where a log that says which process it killed
  // is worth more than one that says it killed something.
  expect(result.stderr).toContain(`(pid ${killed})`);
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
  /**
   * THE BUDGET COVERS MORE THAN IT LOOKS LIKE IT DOES (#706).
   *
   * It reads as "a spawn takes under two seconds", and it never was: at
   * `concurrency: 1` this call is enqueued behind `stalled`, so its deadline
   * spans queue drain and spawn rather than spawn alone. Nothing is compared
   * against it — the claim under test is the line below, that the pool recovers
   * capacity and a later read runs and returns its output — so it is a bound on
   * a hang rather than an assertion, and is raised freely.
   *
   * It used to cover the SIGKILLed child's reap as well, because the timeout
   * path did not free the slot. #743 fixed that; WHEN the slot comes back is
   * now pinned by its own test below rather than hidden inside this budget.
   */
  const recovered = await run(root, ["-e", "process.stdout.write('ready')"], { timeoutMs: 10_000 });
  expect(recovered).toEqual({ status: 0, stdout: "ready", stderr: "" });
  expect(fs.existsSync(marker)).toBe(false);
});

/**
 * THE SLOT COMES BACK AT THE DEADLINE, NOT AT THE REAP — #743.
 *
 * The test above recovers capacity eventually, and that was all it ever claimed.
 * This one pins WHEN, and it is a different property: `release` used to be
 * reachable only from `execFile`'s callback, and that callback fires on stdio
 * EOF rather than on process exit. `SIGKILL` reaps git; it does not reap what
 * git spawned — a clean filter, a `textconv` driver, an fsmonitor hook — and
 * those inherit git's stderr. So the slot was held for the HELPER's lifetime,
 * which nothing here bounds.
 *
 * The fixture reproduces exactly that shape without git: a child that hands its
 * inherited stdio to a helper and then blocks. The helper outlives the SIGKILL
 * by thirty seconds, so before #743 the read below spent its whole ten-second
 * budget queued and returned a timeout instead of `ready`.
 *
 * THE HELPER CALLS `setsid` ON ITSELF, AND THAT IS THE POINT — #771.
 *
 * #771 makes the timeout path kill git's process GROUP, which reaps an ordinary
 * helper. An ordinary helper here would therefore stop holding the pipe, the
 * pipe would close at the deadline, and this test would pass whether `release()`
 * ran on the timeout path or only in the completion callback: still green, and
 * no longer testing anything.
 *
 * A `detached` helper is the case a group kill cannot reach — its own session,
 * out of the group, holding the inherited pipe regardless. Not a contrivance to
 * keep a test alive: it is the residual leak #771 writes down and cannot close
 * (`git fsmonitor--daemon` is the real instance), which makes it the one shape
 * where #770's release-at-the-deadline is still the only thing standing between
 * a stuck helper and a stuck pool.
 */
test("a timed-out read frees its slot while its child's helper still holds the pipe", async () => {
  const root = tmp("telar-git-release-");
  const pidFile = path.join(root, "helper.pid");
  const script = `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    setTimeout(() => {}, 30000);
  `;
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const stalled = run(root, ["-e", script], { timeoutMs: 2_000 });
  // The helper has to be up BEFORE the deadline is allowed to mean anything —
  // see `until`. Its own bound, and a loud failure rather than an `ENOENT`.
  expect(await until(() => fs.existsSync(pidFile), 1_500)).toBe(true);
  expect((await stalled).timedOut).toBe(true);

  const helper = Number(fs.readFileSync(pidFile, "utf8"));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // The premise: the pipe is still held, so the pre-#743 release has not run.
    expect(alive(helper)).toBe(true);
    const recovered = await run(root, ["-e", "process.stdout.write('ready')"], { timeoutMs: 10_000 });
    expect(recovered).toEqual({ status: 0, stdout: "ready", stderr: "" });
    expect(alive(helper)).toBe(true);
  } finally {
    // Reap what this test spawned; nothing of it outlives the test.
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
  }
}, 20_000);

/**
 * THE HELPER IS REAPED, NOT JUST GIT — issue #771, and the point of the test.
 *
 * A test that only asserted the CHILD died would pass against the unfixed
 * timeout path: `child.kill("SIGKILL")` always killed git. The grandchild is the
 * entire content of the issue, so this captures the helper's own pid and asserts
 * that pid is gone. Falsified both ways before being believed — with the group
 * kill removed, and with `detached` removed so the group kill raises `ESRCH` —
 * and it fails on this assertion in both.
 *
 * REAL GIT AND A REAL CLEAN FILTER, because the mechanism is git's: the filter
 * inherits git's stderr, and `close` (like `execFile`'s callback before it)
 * fires on stdio EOF rather than on process exit. A synthetic child reproduces
 * the process shape and not the reason anyone cares about it.
 *
 * THE FILTER BLOCKS INSTEAD OF PASSING CONTENT THROUGH, so the read reaches its
 * deadline with the helper already up rather than racing it. A deadline that
 * fired first would find no helper to kill and the test would pass for the wrong
 * reason — hence `toBeGreaterThan(0)` below, which is the assertion that this
 * test is testing anything at all.
 */
test("a timed-out read reaps the helper git spawned, not only git", async () => {
  const root = tmp("telar-git-group-");
  const pidFile = path.join(root, "helpers.pid");
  const filterPidFile = path.join(root, "filters.pid");
  const filter = path.join(root, "slow-clean.sh");
  /**
   * `>>`, not `>`: git may invoke a clean filter more than once, and a lost pid
   * is a process this test would leak while claiming it reaps them.
   *
   * `wait`, not a second `sleep`: it gives the script exactly one child, so the
   * two pids it records are the whole of what it started. The first draft
   * blocked on its own `sleep`, which nothing recorded — and the falsification
   * run, where nothing is reaped, duly leaked it.
   */
  fs.writeFileSync(filter, `#!/bin/sh
sleep 30 </dev/null >/dev/null &
echo $! >> ${JSON.stringify(pidFile)}
echo $$ >> ${JSON.stringify(filterPidFile)}
wait
`);
  fs.chmodSync(filter, 0o755);

  const projectRoot = repo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Local `false` beats whatever the machine running this has globally: an
  // fsmonitor daemon is a long-running process and this test starts none.
  git("config", "core.fsmonitor", "false");
  git("config", "filter.slow.clean", filter);
  fs.writeFileSync(path.join(projectRoot, ".gitattributes"), "README.md filter=slow\n");
  fs.writeFileSync(path.join(projectRoot, "README.md"), "hello\nchanged\n");

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readPids = (file: string) =>
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

  const run = createAsyncGitRunner({ concurrency: 1 });
  const timedOut = run(projectRoot, ["diff", "-z", "--numstat"], { timeoutMs: 5_000 });
  try {
    // Non-vacuity: a count the "the deadline beat the filter" state cannot
    // produce. The helper's own bound, never the read's — see `until`.
    expect(await until(() => readPids(pidFile).length > 0, 4_500)).toBe(true);

    const result = await timedOut;
    expect(result.timedOut).toBe(true);
    expect(result.killedPid).toBeGreaterThan(0);

    // A SIGKILLed process answers `kill(pid, 0)` until init reaps the zombie, so
    // this is a bound rather than an instant.
    const helpers = readPids(pidFile);
    await until(() => helpers.every(pid => !alive(pid)), 5_000);
    expect(helpers.filter(alive)).toEqual([]);
  } finally {
    await timedOut;
    // Both files, so a run where nothing was reaped still leaves nothing behind.
    for (const pid of [...readPids(pidFile), ...readPids(filterPidFile)]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}, 30_000);

/**
 * A POOL OF ITS OWN, NOT THE SINGLETON. What this test asserts is that the
 * async readers agree with the synchronous ones — nothing about
 * `defaultAsyncGitRunner`. Sharing it made this test's 22 reads queue behind
 * whatever else in the same process holds those four slots, and the pool charges
 * queue time to each call's deadline (worktree.ts:108-155), so an unrelated slow
 * read could spend this test's whole budget before its own git ran. Measured:
 * with the four slots held for 3 s, one read waited 2950 ms and the body went
 * from 338 ms to 3357 ms (docs/investigations/197-git-test-timing.md).
 *
 * Production semantics are unchanged and still covered: the deadline including
 * queue time is what the dedicated pool tests above assert, and the singleton's
 * own construction is checked below.
 */
test("the shared async runner is a bounded runner like any other", async () => {
  // The singleton every EngineState uses by default (state.ts) still has to
  // BE a runner: reachable, and bounded per call. Its queue behaviour is
  // specified by the dedicated pool tests above, on pools those tests own —
  // asserting it here would again couple this file to whatever else in the
  // process is holding its slots.
  const unversioned = tmp("telar-shared-async-");
  const result = await defaultAsyncGitRunner(unversioned, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("not a git repository");
  expect(result.timedOut).toBeUndefined();
});

/**
 * THIS TEST USED TO ASSERT THE DEFECT — issue #813, and the replacement is the
 * two tests below it.
 *
 * It was "a queued read's deadline counts the time it spent queued", and it was
 * a faithful statement of what the runner did: the run timer was armed before
 * the `active < limit` test, so `timeoutMs` bounded queue time plus git time
 * together. #813 is what that costs in production — a `worktree add` killed at
 * a 30 s deadline it had spent waiting for a slot, leaving a session `queued`
 * with no checkout for 45 minutes.
 *
 * WHAT SURVIVES OF IT is the half that was never the bug: a starved call must
 * still fail rather than wait forever, and must not have spawned anything when
 * it does. That is `admissionMs` now, and it is asserted below with its own
 * bound rather than by stealing the run budget.
 */
test("a starved call fails on its admission bound without ever spawning", async () => {
  const root = tmp("telar-git-admission-");
  const marker = path.join(root, "second-ran");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const holder = run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 1_500 });
  const queued = await run(
    root,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    // A run budget far LARGER than the admission bound, so a pass cannot come
    // from the old behaviour: under the pre-#813 runner this call would have
    // sat in the queue for its full 30 s and this test would time out.
    { timeoutMs: 30_000, admissionMs: 100 },
  );
  expect(queued.timedOut).toBe(true);
  // The wait is named, and the kill is not — there was no child to kill, and
  // saying "was killed" about one is what made #813's two failure modes
  // indistinguishable in `preparation.error`.
  expect(queued.stderr).toContain("waited 100ms for a slot and never started");
  expect(queued.stderr).not.toContain("was killed");
  expect(queued.killedPid).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(false);
  expect((await holder).timedOut).toBe(true);
}, 10_000);

/**
 * THE DEADLINE IS MEASURED FROM THE SPAWN — issue #813, test (a), and it is RED
 * on the runner this replaces.
 *
 * One slot, held for 1.5 s by each of two occupants in turn. The third call's
 * run budget is 1.2 s — less than the 3 s it spends waiting, and far more than
 * the instant of work it does. Before #813 its timer started at the call, so it
 * expired in the queue at 1.2 s having done nothing, and its result was status
 * 124 with the marker absent. Now the timer starts when it is spawned, so the
 * 3 s it spent waiting is the admission bound's problem and not the budget's.
 *
 * THE NUMBERS ARE BOTH GENEROUS ON PURPOSE, and the earlier draft is why: at a
 * 300 ms budget this test failed under a loaded `bun test` and passed standalone,
 * because it was measuring interpreter start-up rather than the property. The
 * claim only needs `budget < wait`, so both sides are sized to clear the noise.
 *
 * THE ADMISSION BOUND IS DELIBERATELY LOOSE HERE (10 s). This test's claim is
 * "queue time is no longer charged to the run budget", and pinning it against a
 * tight admission number would make it a test of two things at once — the one
 * above already owns the second.
 */
test("a call held behind two occupied slots still gets its whole run budget", async () => {
  const root = tmp("telar-git-spawn-deadline-");
  const marker = path.join(root, "third-ran");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const first = run(root, ["-e", "setTimeout(() => {}, 1500)"], { timeoutMs: 20_000 });
  const second = run(root, ["-e", "setTimeout(() => {}, 1500)"], { timeoutMs: 20_000 });
  const third = run(
    root,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('ready')`],
    { timeoutMs: 1_200, admissionMs: 10_000 },
  );

  const [a, b, c] = await Promise.all([first, second, third]);
  // Non-vacuity: the two ahead of it must have RUN, not expired — otherwise
  // the third was never queued and the test proves nothing.
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(c.timedOut).toBeUndefined();
  expect(c.status).toBe(0);
  expect(c.stdout).toBe("ready");
  expect(fs.existsSync(marker)).toBe(true);
}, 15_000);

/**
 * AND A CALL THAT SPAWNS AND THEN HANGS IS STILL KILLED, WITH ITS PID — #813,
 * test (b). The half of the old behaviour that must not have moved: the run
 * deadline still fires, still reaps, and still says which process it reaped.
 */
test("a call that spawns and then hangs is killed at its run deadline and reports the pid", async () => {
  const root = tmp("telar-git-spawn-kill-");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const hung = await run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 400, admissionMs: 10_000 });
  expect(hung.timedOut).toBe(true);
  expect(hung.status).toBe(GIT_TIMEOUT_STATUS);
  expect(hung.killedPid).toBeGreaterThan(0);
  expect(hung.stderr).toContain(`(pid ${hung.killedPid})`);
  expect(hung.stderr).toContain("did not finish within 400ms");
  // The group is gone, not merely abandoned. A SIGKILLed process answers
  // `kill(pid, 0)` until it is reaped, so this is a bound rather than an instant.
  await until(() => !alive(hung.killedPid as number), 5_000);
  expect(alive(hung.killedPid as number)).toBe(false);
}, 15_000);

/** `worktree add` no longer shares a number with `git rev-parse` — #813. */
test("a worktree cut is given its own deadline, not a read's", () => {
  expect(WORKTREE_ADD_TIMEOUT_MS).toBeGreaterThan(DEFAULT_GIT_TIMEOUT_MS);
  expect(WORKTREE_ADD_TIMEOUT_MS).toBe(120_000);
  // And a starved cut may wait longer than a starved read, because the callers
  // ahead of it may each legitimately hold a slot for a cut's whole budget.
  expect(WORKTREE_ADMISSION_MS).toBeGreaterThan(WORKTREE_ADD_TIMEOUT_MS);
  expect(DEFAULT_GIT_ADMISSION_MS).toBeGreaterThan(DEFAULT_GIT_TIMEOUT_MS);
});

/**
 * AND THE CUT ACTUALLY ASKS FOR IT. The constant existing proves nothing —
 * `createSessionWorktreeAsync` passing no `timeoutMs` at all is exactly what
 * #813 was. This records the options the `worktree add` call carries.
 */
test("createSessionWorktreeAsync passes the worktree deadline down to git", async () => {
  const calls: Array<{ args: string[]; options?: { timeoutMs?: number } }> = [];
  const recording: AsyncGitRunner = async (_cwd, args, options) => {
    calls.push({ args, ...(options ? { options } : {}) });
    return { status: 0, stdout: "", stderr: "" };
  };
  const engineRoot = tmp("telar-cut-deadline-engine-");
  const projectRoot = tmp("telar-cut-deadline-project-");
  await createSessionWorktreeAsync(recording, {
    engineRoot,
    projectRoot,
    plan: { path: path.join(engineRoot, "cut"), branch: "telar/deadline", named: false },
    baseSha: "base000",
  });
  const add = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  expect(add).toBeDefined();
  expect(add!.options?.timeoutMs).toBe(WORKTREE_ADD_TIMEOUT_MS);
});

test("async git reads preserve overview and review data for committed and untracked changes", async () => {
  const asyncGit = createAsyncGitRunner();
  const root = repo();
  const base = defaultGitRunner(root, ["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(root, "README.md"), "hello\ncommitted\n");
  defaultGitRunner(root, ["commit", "-am", "second"]);
  fs.writeFileSync(path.join(root, "README.md"), "hello\ncommitted\nworking\n");
  fs.writeFileSync(path.join(root, "new.txt"), "new file\n");
  const input = { cwd: root, baseRef: base };
  expect(await gitOverviewAsync(asyncGit, root)).toEqual(gitOverview(defaultGitRunner, root));
  const diff = await sessionDiffAsync(asyncGit, input);
  expect(diff).toEqual(sessionDiff(defaultGitRunner, input));
  expect(diff.commits).toHaveLength(1);
  expect(diff.files.map(file => file.path)).toEqual(["new.txt", "README.md"].sort((a, b) => a.localeCompare(b)));
  for (const patchInput of [
    { ...input, path: "README.md" },
    { ...input, path: "new.txt", untracked: true },
    { ...input, baseRef: "deleted-base", path: "README.md" },
  ]) {
    const patch = await sessionFilePatchAsync(asyncGit, patchInput);
    expect(patch).toEqual(sessionFilePatch(defaultGitRunner, patchInput));
    expect(patch.patch).not.toBe("");
  }
});
