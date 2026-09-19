/**
 * MOVING CHECKOUTS THAT ARE ALREADY CUT — issue #642 part 2.
 *
 * AGAINST REAL GIT REPOSITORIES, not a fake runner, because every claim here is
 * a claim about what git does: that `worktree remove` refuses a dirty checkout,
 * that `worktree add` on the same branch restores the same commit, that a
 * branch which no longer exists cannot be re-cut. A fake that agreed with my
 * reading of the manual would be testing the reading.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultAsyncGitRunner } from "../src/worktree";
import { describeOutcome, moveCheckouts, WorktreeMoveError, type Checkout } from "../src/worktrees-move";

const made: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repo(): string {
  const root = tmp("telar-move-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

/** A checkout with a commit in it, the way a session leaves one. */
function cut(projectRoot: string, root: string, branch: string): Checkout {
  const target = path.join(root, `${branch.replace(/\//g, "--")}-abcd1234`);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(projectRoot, "worktree", "add", "-q", "-b", branch, target, "HEAD");
  fs.writeFileSync(path.join(target, "work.txt"), `work for ${branch}\n`);
  git(target, "add", "-A");
  git(target, "commit", "-qm", `work for ${branch}`);
  return { sessionId: `session_${branch.replace(/\W/g, "")}`, path: target, branch, projectRoot, busy: false };
}

const sha = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

test("a checkout is re-cut at the new root, with its commit and its files", async () => {
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const to = tmp("telar-move-to-");
  const checkout = cut(projectRoot, from, "telar/one");
  const before = sha(checkout.path);
  const rewritten: Record<string, string> = {};

  const outcome = await moveCheckouts(defaultAsyncGitRunner, {
    checkouts: [checkout],
    destination: to,
    onMoved: (sessionId, target) => {
      rewritten[sessionId] = target;
    },
  });

  expect(outcome.skipped).toEqual([]);
  expect(outcome.moved).toHaveLength(1);
  const landed = outcome.moved[0]!.to;
  // THE COMMITS WERE NEVER IN THE WORKTREE. This is the premise the whole
  // design rests on, so it is asserted rather than assumed.
  expect(sha(landed)).toBe(before);
  expect(fs.readFileSync(path.join(landed, "work.txt"), "utf8")).toBe("work for telar/one\n");
  expect(fs.existsSync(checkout.path)).toBe(false);
  // And the session's recorded path was rewritten — the commit point.
  expect(rewritten[checkout.sessionId]).toBe(landed);
});

test("a dirty checkout is refused by git itself and stays exactly where it is", async () => {
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const to = tmp("telar-move-to-");
  const checkout = cut(projectRoot, from, "telar/dirty");
  fs.writeFileSync(path.join(checkout.path, "uncommitted.txt"), "work nobody has committed\n");
  const rewritten: string[] = [];

  const outcome = await moveCheckouts(defaultAsyncGitRunner, {
    checkouts: [checkout],
    destination: to,
    onMoved: (sessionId) => rewritten.push(sessionId),
  });

  expect(outcome.moved).toEqual([]);
  expect(outcome.skipped[0]).toMatchObject({ sessionId: checkout.sessionId, reason: "dirty" });
  /**
   * NOT A HAND-BUILT GUARD. `git worktree remove` fails on modified or
   * untracked files without `--force`, and this operation never passes
   * `--force` — so the safety property is the tool's, at exactly the right
   * moment, per checkout.
   */
  expect(fs.readFileSync(path.join(checkout.path, "uncommitted.txt"), "utf8")).toBe("work nobody has committed\n");
  expect(rewritten).toEqual([]);
});

test("a checkout whose branch is gone is left alone — the branch is checked BEFORE anything is removed", async () => {
  /**
   * #641: `gh pr merge --delete-branch` destroys the local branch as well as
   * the remote one, so a session whose PR was merged before that fix may hold
   * a checkout with no branch left. Under re-cutting that is unrecoverable —
   * `remove` would succeed and `add` would have nothing to check out — which
   * is why "reproducible from a branch that still exists" is verified rather
   * than assumed.
   */
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const to = tmp("telar-move-to-");
  const checkout = cut(projectRoot, from, "telar/merged");

  /**
   * AND GIT NARROWS THE HOLE BY ITSELF, which is worth recording because it
   * changes how this can arise: `git branch -D` REFUSES a branch that a
   * registered worktree is using ("cannot delete branch 'x' used by worktree
   * at ..."). So the merge cannot strand a live registration.
   *
   * What #641 actually produced is this: the worktree was destroyed and
   * pruned, THEN the branch went, and the session record was left naming both.
   * That is what is reconstructed here — and it is exactly the state where
   * removing before checking would have nothing to re-cut from.
   */
  execFileSync("git", ["worktree", "remove", checkout.path], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["branch", "-D", "telar/merged"], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });

  const outcome = await moveCheckouts(defaultAsyncGitRunner, { checkouts: [checkout], destination: to, onMoved: () => undefined });

  expect(outcome.moved).toEqual([]);
  expect(outcome.skipped[0]).toMatchObject({ reason: "branch-gone", detail: "telar/merged" });
  // Nothing was created at the destination for a checkout that could not be
  // re-cut — a half-made empty folder there would look like a moved session.
  expect(fs.readdirSync(to)).toEqual([]);
});

test("one session still working refuses the WHOLE operation, before anything is touched", async () => {
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const to = tmp("telar-move-to-");
  const quiet = cut(projectRoot, from, "telar/quiet");
  const working = { ...cut(projectRoot, from, "telar/working"), busy: true };

  await expect(
    moveCheckouts(defaultAsyncGitRunner, { checkouts: [quiet, working], destination: to, onMoved: () => undefined }),
  ).rejects.toThrow(WorktreeMoveError);

  // "A half-migrated worktrees root loses uncommitted work in every open
  // session" — so not even the quiet one moves while a turn is in flight.
  expect(fs.existsSync(quiet.path)).toBe(true);
  expect(fs.existsSync(working.path)).toBe(true);
});

test("a partial move is safe: the clean ones go, the dirty one stays, and it can be run again", async () => {
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const to = tmp("telar-move-to-");
  const clean = cut(projectRoot, from, "telar/clean");
  const dirty = cut(projectRoot, from, "telar/messy");
  fs.writeFileSync(path.join(dirty.path, "scratch.txt"), "later\n");

  const first = await moveCheckouts(defaultAsyncGitRunner, { checkouts: [clean, dirty], destination: to, onMoved: () => undefined });
  expect(first.moved).toHaveLength(1);
  expect(first.skipped).toHaveLength(1);

  // Commit the work and press it again — each checkout is independent, so the
  // rest move without redoing the ones that already did.
  execFileSync("git", ["add", "-A"], { cwd: dirty.path, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["commit", "-qm", "later"], { cwd: dirty.path, stdio: ["ignore", "pipe", "pipe"] });

  const second = await moveCheckouts(defaultAsyncGitRunner, { checkouts: [dirty], destination: to, onMoved: () => undefined });
  expect(second.moved).toHaveLength(1);
  expect(second.skipped).toEqual([]);
});

test("nothing is ever forced", async () => {
  /**
   * THE ONE LINE THIS OPERATION MUST NOT GROW. A `--force` on the remove would
   * turn git's refusal — the safety property the whole design leans on — into
   * a silent deletion of somebody's uncommitted work.
   */
  const source = fs.readFileSync(new URL("../src/worktrees-move.ts", import.meta.url), "utf8");
  const commands = source.match(/"worktree",\s*"remove"[^\]]*\]/g) ?? [];
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) expect(command).not.toContain("--force");
});

test("a failed re-add puts the checkout back where it was", async () => {
  const projectRoot = repo();
  const from = tmp("telar-move-from-");
  const checkout = cut(projectRoot, from, "telar/unlucky");
  const before = sha(checkout.path);

  // A destination that cannot hold a checkout: a FILE where the directory
  // would go, so `worktree add` fails after `remove` has already succeeded.
  const to = tmp("telar-move-to-");
  fs.writeFileSync(path.join(to, path.basename(checkout.path)), "in the way\n");

  const outcome = await moveCheckouts(defaultAsyncGitRunner, { checkouts: [checkout], destination: to, onMoved: () => undefined });

  expect(outcome.moved).toEqual([]);
  expect(outcome.skipped[0]).toMatchObject({ reason: "failed" });
  // Restored: a failed move must leave the session exactly as it started,
  // which is the difference between a failure and a lost checkout.
  expect(fs.existsSync(checkout.path)).toBe(true);
  expect(sha(checkout.path)).toBe(before);
});

test("what a person is told separates the reasons, because they lead different places", () => {
  const outcome = {
    moved: [{ sessionId: "a", from: "/old/a", to: "/new/a" }],
    skipped: [
      { sessionId: "b", path: "/old/b", reason: "dirty" as const },
      { sessionId: "c", path: "/old/c", reason: "branch-gone" as const },
    ],
  };
  const said = describeOutcome(outcome);
  expect(said).toContain("Moved 1 checkout.");
  // Commit it and try again…
  expect(said).toContain("commit them and run this again");
  // …is the wrong advice for a branch that no longer exists, so it is not what
  // that one is told.
  expect(said).toContain("no longer exist");
});
