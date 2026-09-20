/**
 * PUBLISHING A SESSION'S BRANCH — issue #670.
 *
 * THE TRAP THIS SUITE IS WRITTEN AGAINST is testing only that the allowed thing
 * works. A push that pushes is one assertion; the ten refusals are where a
 * person either finds out what to do or is handed a subprocess dump, and five of
 * them are supposed to happen WITHOUT GIT BEING ASKED. "Refused" and "tried and
 * happened to fail" look identical from the outside, so the assertion for those
 * five is on the RUNNER'S CALL LIST — what did and did not run — rather than on
 * the answer alone.
 *
 * EVERY STDERR BELOW IS GIT'S OWN, and the ones that could be produced without
 * a network were. The no-origin, non-fast-forward, hook-decline and
 * `Everything up-to-date` fixtures were captured from real `git push` runs
 * against a local bare repository in a temp directory — two clones, a
 * `pre-receive` hook, no remote host involved. The two that need GitHub's
 * server to produce (a 403 and an HTTPS credential prompt refused by
 * `GIT_TERMINAL_PROMPT=0`) are transcribed from git's and GitHub's own wording,
 * and are marked as such where they appear. NO TEST IN THIS FILE RUNS A REAL
 * PUSH.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyPushFailure,
  PUSH_ENV,
  PUSH_TIMEOUT_MS,
  pushArgv,
  pushMovedNothing,
  pushSessionBranch,
  pullRequestBlockedBy,
  sessionBranchFacts,
} from "../src/git";
import { GIT_TIMEOUT_STATUS } from "../src/worktree";
import type { AsyncGitRunner, GitResult, GitRunOptions } from "../src/worktree";

const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "fatal", status = 1): GitResult => ({ status, stdout: "", stderr });
const timedOut = (what: string): GitResult => ({
  status: GIT_TIMEOUT_STATUS,
  stdout: "",
  stderr: `git ${what} in /repo did not finish within 30000ms and was killed`,
  timedOut: true,
});

type Call = { args: string[]; options?: GitRunOptions };

/**
 * A runner that RECORDS. The recording is the point of half this file: for a
 * refusal decided from data, the assertion is about what never ran.
 *
 * Keyed on the first two argv words, which separates all six commands this code
 * issues — the three `rev-parse` forms differ on their second word.
 */
function spy(replies: Record<string, GitResult>, calls: Call[] = []): { git: AsyncGitRunner; calls: Call[] } {
  const git: AsyncGitRunner = async (_cwd, args, options) => {
    calls.push({ args, ...(options ? { options } : {}) });
    return replies[args.slice(0, 2).join(" ")] ?? fail(`unexpected call: git ${args.join(" ")}`);
  };
  return { git, calls };
}

const BRANCH = "telar/670-push";
const TRACKING = `refs/remotes/origin/${BRANCH}`;

/** A checkout on its own branch, with an origin and one commit the remote has
 *  not seen. The state every happy path below starts from. */
const READY: Record<string, GitResult> = {
  "rev-parse --is-inside-work-tree": ok("true\n"),
  "rev-parse --abbrev-ref": ok(`${BRANCH}\n`),
  "config --get": ok("git@github.com:Facundo-Barbera/Telar.git\n"),
  "rev-parse --verify": ok("0f1c2d3\n"),
  "rev-list --count": ok("3\n"),
  "push --set-upstream": ok(),
};

/** Every `git push` argv the runner was asked to run. The list this suite
 *  asserts is EMPTY for a refusal decided from data. */
const pushes = (calls: Call[]) => calls.filter((call) => call.args[0] === "push");

describe("the push argv", () => {
  test("is fixed, and carries nothing that could overwrite what the remote has", () => {
    expect(pushArgv(BRANCH)).toEqual(["push", "--set-upstream", "origin", BRANCH]);
  });

  test("refuses a credential prompt rather than answering one", () => {
    // The whole environment, asserted as a whole: a second variable appearing
    // here would be this engine deciding something about credentials, which is
    // the one thing `git.ts`'s header says it must never do.
    expect(PUSH_ENV).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  test("runs with its own bound, longer than a read's and still finite", () => {
    expect(PUSH_TIMEOUT_MS).toBe(60_000);
  });

  test("the push is issued with both, and with nothing else", async () => {
    const { git, calls } = spy(READY);
    await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH });
    const [push] = pushes(calls);
    expect(push?.args).toEqual(["push", "--set-upstream", "origin", BRANCH]);
    expect(push?.options).toEqual({ timeoutMs: PUSH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" } });
  });
});

describe("a push that works", () => {
  test("reports the branch and the count it measured before pushing", async () => {
    const { git } = spy(READY);
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toEqual({
      pushed: true,
      branch: BRANCH,
      commits: 3,
    });
  });

  test("a branch the remote has never seen is reported as created, with no count it could not take", async () => {
    // No remote-tracking ref, so `rev-list --count` has nothing to count
    // against — and ABSENT is the answer, never 0, which would read as a branch
    // with nothing on it.
    const { git, calls } = spy({ ...READY, "rev-parse --verify": fail("", 1) });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toEqual({
      pushed: true,
      branch: BRANCH,
      created: true,
    });
    expect(calls.filter((call) => call.args[0] === "rev-list")).toHaveLength(0);
  });
});

/**
 * THE FIVE REFUSALS THE ENGINE DECIDES ITSELF, and the assertion that makes them
 * mean anything: `git push` was never run. Without it, every one of these tests
 * would pass just as happily against a version that pushed and got lucky.
 */
describe("refusals decided from data, with nothing pushed", () => {
  test("a local session: git is not run AT ALL, not even to look", async () => {
    const { git, calls } = spy({});
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "local" })).toMatchObject({ pushed: false, refusal: "local_checkout" });
    // The strongest form of this assertion, and the only refusal that can carry
    // it: a `local` session is decided from the session record, so there is
    // nothing to look at and no subprocess to spawn.
    expect(calls).toEqual([]);
  });

  test("not a git repository: one probe, and no push", async () => {
    const { git, calls } = spy({ "rev-parse --is-inside-work-tree": fail("fatal: not a git repository") });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toMatchObject({
      pushed: false,
      refusal: "not_repository",
    });
    expect(pushes(calls)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("no origin: the remote is never contacted, because there is no remote to contact", async () => {
    const { git, calls } = spy({ ...READY, "config --get": fail("", 1) });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toMatchObject({
      pushed: false,
      refusal: "no_remote",
    });
    expect(pushes(calls)).toEqual([]);
  });

  test("the checkout is on another branch: the base is not pushed in the session branch's name", async () => {
    // The case this guard exists for: an agent ran `git checkout main` in the
    // worktree, and a button that pushed "whatever is here" would publish main.
    const { git, calls } = spy({ ...READY, "rev-parse --abbrev-ref": ok("main\n") });
    const result = await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH });
    expect(result).toMatchObject({ pushed: false, refusal: "not_session_branch" });
    expect(result).toHaveProperty("message", `This checkout is on main, not on this session's branch ${BRANCH}.`);
    expect(pushes(calls)).toEqual([]);
  });

  test("a detached HEAD is the same guard, said differently", async () => {
    const { git, calls } = spy({ ...READY, "rev-parse --abbrev-ref": ok("HEAD\n") });
    const result = await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH });
    expect(result).toMatchObject({ pushed: false, refusal: "not_session_branch" });
    expect(result).toHaveProperty("message", `This checkout is not on a branch, so ${BRANCH} is not what would be pushed.`);
    expect(pushes(calls)).toEqual([]);
  });

  test("nothing ahead is not an error, and costs no round trip", async () => {
    const { git, calls } = spy({ ...READY, "rev-list --count": ok("0\n") });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toMatchObject({
      pushed: false,
      refusal: "nothing_to_push",
    });
    expect(pushes(calls)).toEqual([]);
  });

  test("a session with no branch recorded never reaches git", async () => {
    const { git, calls } = spy({});
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree" })).toMatchObject({
      pushed: false,
      refusal: "not_session_branch",
    });
    expect(calls).toEqual([]);
  });
});

/**
 * A KILLED PROBE IS NOT A FACT ABOUT THE REPOSITORY — the lesson `GitReadFailure`
 * states and `commitSessionWork` already learnt. A timeout here must not become
 * "your checkout is not a git repository", which sends somebody looking for a
 * problem that is not there.
 */
describe("a probe that was killed", () => {
  for (const [key, what] of [
    ["rev-parse --is-inside-work-tree", "rev-parse"],
    ["rev-parse --abbrev-ref", "rev-parse"],
    ["config --get", "config"],
    ["rev-parse --verify", "rev-parse"],
    ["rev-list --count", "rev-list"],
  ] as const) {
    test(`\`${key}\` timing out is reported as a timeout, and pushes nothing`, async () => {
      const { git, calls } = spy({ ...READY, [key]: timedOut(what) });
      const result = await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH });
      expect(result).toMatchObject({ pushed: false, refusal: "timeout" });
      expect(result).toHaveProperty("message", "git did not answer in time — try again.");
      expect(pushes(calls)).toEqual([]);
    });
  }

  test("the push itself timing out is a timeout rather than a classified failure", async () => {
    const { git } = spy({ ...READY, "push --set-upstream": timedOut("push") });
    const result = await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH });
    // `timedOut` is checked BEFORE the status, because a killed child also
    // carries a non-zero one — and `classifyPushFailure` would read the
    // runner's own "was killed" sentence as an unrecognised git failure.
    expect(result).toMatchObject({ pushed: false, refusal: "timeout" });
    expect(result).toHaveProperty("message", "The push did not finish within 60s and was stopped.");
  });
});

/**
 * REAL STDERR, EVERY ONE OF THEM. The four captured fixtures were produced by
 * running the real command against a local bare repository; the two GitHub ones
 * are transcribed and say so.
 */
describe("classifyPushFailure", () => {
  /** CAPTURED. `git push --set-upstream origin main` in a repository with no
   *  origin at all. */
  const NO_ORIGIN = [
    "fatal: 'origin' does not appear to be a git repository",
    "fatal: Could not read from remote repository.",
    "",
    "Please make sure you have the correct access rights",
    "and the repository exists.",
  ].join("\n");

  /** CAPTURED. Two clones of one bare repository; the other one pushed first. */
  const NON_FAST_FORWARD = [
    "To /tmp/telar-push-fx/remote.git",
    " ! [rejected]        main -> main (fetch first)",
    "error: failed to push some refs to '/tmp/telar-push-fx/remote.git'",
    "hint: Updates were rejected because the remote contains work that you do not",
    "hint: have locally. This is usually caused by another repository pushing to",
    "hint: the same ref. If you want to integrate the remote changes, use",
    "hint: 'git pull' before pushing again.",
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  ].join("\n");

  /** CAPTURED. A `pre-receive` hook on the bare repository exiting non-zero —
   *  the local stand-in for GitHub's branch protection, which wears the same
   *  `! [remote rejected]` line. */
  const HOOK_DECLINED = [
    "remote: remote: You are not allowed to push to main.        ",
    "To /tmp/telar-push-fx/remote.git",
    " ! [remote rejected] main -> main (pre-receive hook declined)",
    "error: failed to push some refs to '/tmp/telar-push-fx/remote.git'",
  ].join("\n");

  /** TRANSCRIBED — GitHub's 403 for an account without write access. Producing
   *  this needs GitHub's own server, and no test here talks to one. */
  const FORBIDDEN = [
    "remote: Permission to Facundo-Barbera/Telar.git denied to someone.",
    "fatal: unable to access 'https://github.com/Facundo-Barbera/Telar.git/': The requested URL returned error: 403",
  ].join("\n");

  /** TRANSCRIBED — what `GIT_TERMINAL_PROMPT=0` turns a credential prompt into.
   *  Without it this hangs until the timeout instead, which is the whole reason
   *  the variable is set. */
  const PROMPT_REFUSED = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

  /** TRANSCRIBED — SSH with no usable key. The reason `auth` is tested before
   *  `not_permitted`: this says "Permission denied" and is not a permission
   *  problem with the repository at all. */
  const NO_KEY = ["git@github.com: Permission denied (publickey).", "fatal: Could not read from remote repository."].join("\n");

  const classify = (stderr: string) => classifyPushFailure({ stdout: "", stderr });

  test("a checkout with no origin is named as having no remote, not as a broken push", () => {
    expect(classify(NO_ORIGIN).refusal).toBe("no_remote");
  });

  test("a diverged branch is `rejected`, and the remedy in its message is git's own — pull, never force", () => {
    expect(classify(NON_FAST_FORWARD).refusal).toBe("rejected");
    expect(classify(NON_FAST_FORWARD).message).toContain("fetch first");
  });

  test("THE FAR SIDE SAYING NO IS NOT A DIVERGED BRANCH, though git prints both through a `rejected` line", () => {
    /**
     * The measured pair, and the whole reason these are two refusals:
     *
     *    ! [remote rejected] main -> main (pre-receive hook declined)
     *    ! [rejected]        main -> main (fetch first)
     *
     * The first needs a different branch or a different account; the second
     * needs a pull. Telling somebody to rebase a branch a hook declined wastes
     * their afternoon.
     *
     * SEPARATED BY TOKENS RATHER THAN BY ORDER, and this test says so because
     * the instinct is to assume the order is doing the work. It is not:
     * `[remote rejected]` does not contain `[rejected]`, so the two sets are
     * disjoint — measured by swapping the blocks, which changed nothing.
     */
    expect(classify(HOOK_DECLINED).refusal).toBe("not_permitted");
    expect(classify(NON_FAST_FORWARD).refusal).toBe("rejected");
  });

  test("a 403 is a permission problem and a missing key is not, though both say `Permission denied`", () => {
    /**
     * SEPARATED BY TOKENS, NOT BY ORDER, and this test says which — because the
     * instinct is to assume order and because the first draft of the comment on
     * `classifyPushFailure` claimed exactly that and was wrong.
     *
     * Measured by reverting: drop `permission denied (publickey)` from the
     * `auth` block and `NO_KEY` does NOT fall through to `not_permitted` — it
     * lands on `failed`, because it matches none of that block's tokens either.
     * So what keeps these two apart is which words each block looks for, and
     * the assertion below is on the two answers rather than on an order that is
     * not doing any work.
     */
    expect(classify(FORBIDDEN).refusal).toBe("not_permitted");
    expect(classify(NO_KEY).refusal).toBe("auth");
    // The claim underneath: neither fixture is in the other's vocabulary at
    // all, which is what makes the pair robust to somebody reordering the file.
    const NOT_PERMITTED_TOKENS = ["[remote rejected]", "hook declined", "protected branch", "denied to", "http 403", "error: 403", "write access", "permission to"];
    expect(NOT_PERMITTED_TOKENS.some((token) => NO_KEY.toLowerCase().includes(token))).toBe(false);
  });

  test("a refused credential prompt is `auth`, which is what the environment variable buys", () => {
    expect(classify(PROMPT_REFUSED).refusal).toBe("auth");
  });

  test("an unrecognised refusal keeps git's own words rather than guessing", () => {
    expect(classify("error: something entirely new")).toEqual({ refusal: "failed", message: "error: something entirely new" });
  });

  test("every fixture carries git's own sentence through to the reader", () => {
    for (const fixture of [NO_ORIGIN, NON_FAST_FORWARD, HOOK_DECLINED, FORBIDDEN, PROMPT_REFUSED, NO_KEY]) {
      expect(classify(fixture).message).toBe(fixture.trim());
    }
  });
});

describe("a push that exited 0 and moved nothing", () => {
  /** CAPTURED. `Everything up-to-date` arrives on stderr; `--set-upstream`'s own
   *  confirmation arrives on stdout. Both streams are read for that reason. */
  test("is reported as nothing to push rather than as a push", async () => {
    const { git } = spy({
      ...READY,
      // The remote-tracking ref says 2 ahead — stale, because somebody else
      // already pushed these — and git's answer is the correction.
      "push --set-upstream": {
        status: 0,
        stdout: `branch '${BRANCH}' set up to track 'origin/${BRANCH}'.\n`,
        stderr: "Everything up-to-date\n",
      },
    });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toMatchObject({
      pushed: false,
      refusal: "nothing_to_push",
    });
  });

  test("the phrase is found on either stream", () => {
    expect(pushMovedNothing({ stdout: "", stderr: "Everything up-to-date\n" })).toBe(true);
    expect(pushMovedNothing({ stdout: "Everything up-to-date\n", stderr: "" })).toBe(true);
    expect(pushMovedNothing({ stdout: "", stderr: `branch '${BRANCH}' set up to track.\n` })).toBe(false);
  });

  test("a real push's own output is not mistaken for it", () => {
    // CAPTURED, from the successful push in the same temp repository.
    const real = ["To /tmp/telar-push-fx/remote.git", "   46655fa..8571e51  main -> main", "branch 'main' set up to track 'origin/main'."].join("\n");
    expect(pushMovedNothing({ stdout: "", stderr: real })).toBe(false);
  });
});

describe("sessionBranchFacts", () => {
  test("reads the checkout without ever reaching the network", async () => {
    const { git, calls } = spy(READY);
    expect(await sessionBranchFacts(git, "/repo")).toEqual({
      repository: true,
      branch: BRANCH,
      origin: "git@github.com:Facundo-Barbera/Telar.git",
      upstream: true,
      ahead: 3,
    });
    // Every one of these is a local read. `push`, `fetch`, `ls-remote` and
    // `pull` are the four that would not be, and none of them is here.
    expect(calls.map((call) => call.args[0])).toEqual(["rev-parse", "rev-parse", "config", "rev-parse", "rev-list"]);
  });

  test("the remote-tracking ref is read by name, so a branch called `main` is not asked about", async () => {
    const { git, calls } = spy(READY);
    await sessionBranchFacts(git, "/repo");
    expect(calls[3]?.args).toEqual(["rev-parse", "--verify", "--quiet", TRACKING]);
    expect(calls[4]?.args).toEqual(["rev-list", "--count", `${TRACKING}..HEAD`]);
  });

  test("a detached HEAD has no branch, and `HEAD` is not offered as one", async () => {
    const { git } = spy({ ...READY, "rev-parse --abbrev-ref": ok("HEAD\n") });
    expect(await sessionBranchFacts(git, "/repo")).toEqual({
      repository: true,
      origin: "git@github.com:Facundo-Barbera/Telar.git",
    });
  });

  test("an unreadable count leaves `ahead` absent rather than 0", async () => {
    // 0 would read as "level with the remote", which is a specific claim about
    // the branch that nobody measured.
    const { git } = spy({ ...READY, "rev-list --count": fail("fatal: bad revision") });
    const facts = await sessionBranchFacts(git, "/repo");
    expect(facts.upstream).toBe(true);
    expect(facts).not.toHaveProperty("ahead");
  });
});

/**
 * THE TWO ARMS DISAGREE ABOUT EXACTLY ONE THING, and #670's investigation is
 * explicit that they must: a branch with no upstream is what the push arm exists
 * for and the one state a pull request cannot be opened on. This is where that
 * stops being a UI opinion.
 */
describe("pullRequestBlockedBy", () => {
  const facts = {
    repository: true,
    branch: BRANCH,
    origin: "git@github.com:Facundo-Barbera/Telar.git",
  } as const;

  test("a branch level with its upstream blocks a push and not a pull request", async () => {
    const level = { ...facts, upstream: true, ahead: 0 };
    expect(pullRequestBlockedBy(level, BRANCH)).toBeUndefined();
    const { git } = spy({ ...READY, "rev-list --count": ok("0\n") });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toMatchObject({ refusal: "nothing_to_push" });
  });

  test("the refusals both arms share are shared", () => {
    expect(pullRequestBlockedBy({ repository: false }, BRANCH)?.refusal).toBe("not_repository");
    expect(pullRequestBlockedBy({ repository: true, timedOut: true }, BRANCH)?.refusal).toBe("timeout");
    expect(pullRequestBlockedBy({ repository: true, branch: BRANCH }, BRANCH)?.refusal).toBe("no_remote");
    expect(pullRequestBlockedBy({ ...facts, branch: "main" }, BRANCH)?.refusal).toBe("not_session_branch");
  });
});
