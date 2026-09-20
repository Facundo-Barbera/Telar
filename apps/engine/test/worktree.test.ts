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
import { createAsyncGitRunner, defaultAsyncGitRunner, createGitRunner, createSessionWorktreeAsync, createWorktreeQueue, DEFAULT_GIT_TIMEOUT_MS, defaultGitRunner, GIT_TIMEOUT_STATUS, lockSessionWorktree, prepareSessionWorktree, removeSessionWorktreeAsync, repairWorktree, WorktreeError, worktreeLockReason, defaultWorktreesRoot, type AsyncGitRunner, type GitRunner } from "../src/worktree";
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
 */
test("a timed-out read frees its slot while its child's helper still holds the pipe", async () => {
  const root = tmp("telar-git-release-");
  const pidFile = path.join(root, "helper.pid");
  const script = `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    setTimeout(() => {}, 30000);
  `;
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const stalled = run(root, ["-e", script], { timeoutMs: 500 });
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

test("a queued read's deadline counts the time it spent queued", async () => {
  // The property the parity test must not depend on, pinned where it belongs:
  // on a pool this test owns. One slot, occupied; the second read's 100ms
  // budget expires while it is still in the queue, so it reports a timeout
  // without ever having been spawned.
  const root = tmp("telar-queue-deadline-");
  const marker = path.join(root, "second-ran");
  const run = createAsyncGitRunner({ gitBin: process.execPath, concurrency: 1 });
  const holder = run(root, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 1_500 });
  const queued = await run(root, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { timeoutMs: 100 });
  expect(queued.timedOut).toBe(true);
  expect(queued.stderr).toContain("did not finish within 100ms");
  expect(fs.existsSync(marker)).toBe(false);
  expect((await holder).timedOut).toBe(true);
}, 10_000);

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
