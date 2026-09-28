import { describe, expect, test } from "bun:test";
import { classifyPushFailure, pullRequestBlockedBy, PUSH_ENV, PUSH_TIMEOUT_MS, pushArgv, pushMovedNothing, pushSessionBranch, sessionBranchFacts } from "./push";
import { GIT_TIMEOUT_STATUS } from "../../worktree";
import type { AsyncGitRunner, GitResult, GitRunOptions } from "../../worktree";

const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "fatal", status = 1): GitResult => ({ status, stdout: "", stderr });
const timedOut = (what: string): GitResult => ({
  status: GIT_TIMEOUT_STATUS,
  stdout: "",
  stderr: `git ${what} in /repo did not finish within 30000ms and was killed`,
  timedOut: true,
});

type Call = { args: string[]; options?: GitRunOptions };

function spy(replies: Record<string, GitResult>, calls: Call[] = []): { git: AsyncGitRunner; calls: Call[] } {
  const git: AsyncGitRunner = async (_cwd, args, options) => {
    calls.push({ args, ...(options ? { options } : {}) });
    return replies[args.slice(0, 2).join(" ")] ?? fail(`unexpected call: git ${args.join(" ")}`);
  };
  return { git, calls };
}

const BRANCH = "telar/670-push";
const TRACKING = `refs/remotes/origin/${BRANCH}`;

const READY: Record<string, GitResult> = {
  "rev-parse --is-inside-work-tree": ok("true\n"),
  "rev-parse --abbrev-ref": ok(`${BRANCH}\n`),
  "config --get": ok("git@github.com:NovarixHQ/Telar.git\n"),
  "rev-parse --verify": ok("0f1c2d3\n"),
  "rev-list --count": ok("3\n"),
  "push --set-upstream": ok(),
};

const pushes = (calls: Call[]) => calls.filter((call) => call.args[0] === "push");

describe("the push argv", () => {
  test("is fixed, and carries nothing that could overwrite what the remote has", () => {
    expect(pushArgv(BRANCH)).toEqual(["push", "--set-upstream", "origin", BRANCH]);
  });

  test("refuses a credential prompt rather than answering one", () => {
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
    const { git, calls } = spy({ ...READY, "rev-parse --verify": fail("", 1) });
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "worktree", branch: BRANCH })).toEqual({
      pushed: true,
      branch: BRANCH,
      created: true,
    });
    expect(calls.filter((call) => call.args[0] === "rev-list")).toHaveLength(0);
  });
});

describe("refusals decided from data, with nothing pushed", () => {
  test("a local session: git is not run AT ALL, not even to look", async () => {
    const { git, calls } = spy({});
    expect(await pushSessionBranch(git, { cwd: "/repo", mode: "local" })).toMatchObject({ pushed: false, refusal: "local_checkout" });
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
    expect(result).toMatchObject({ pushed: false, refusal: "timeout" });
    expect(result).toHaveProperty("message", "The push did not finish within 60s and was stopped.");
  });
});

describe("classifyPushFailure", () => {
  const NO_ORIGIN = [
    "fatal: 'origin' does not appear to be a git repository",
    "fatal: Could not read from remote repository.",
    "",
    "Please make sure you have the correct access rights",
    "and the repository exists.",
  ].join("\n");

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

  const HOOK_DECLINED = [
    "remote: remote: You are not allowed to push to main.        ",
    "To /tmp/telar-push-fx/remote.git",
    " ! [remote rejected] main -> main (pre-receive hook declined)",
    "error: failed to push some refs to '/tmp/telar-push-fx/remote.git'",
  ].join("\n");

  const FORBIDDEN = [
    "remote: Permission to NovarixHQ/Telar.git denied to someone.",
    "fatal: unable to access 'https://github.com/NovarixHQ/Telar.git/': The requested URL returned error: 403",
  ].join("\n");

  const PROMPT_REFUSED = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

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
    expect(classify(HOOK_DECLINED).refusal).toBe("not_permitted");
    expect(classify(NON_FAST_FORWARD).refusal).toBe("rejected");
  });

  test("a 403 is a permission problem and a missing key is not, though both say `Permission denied`", () => {
    expect(classify(FORBIDDEN).refusal).toBe("not_permitted");
    expect(classify(NO_KEY).refusal).toBe("auth");
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
  test("is reported as nothing to push rather than as a push", async () => {
    const { git } = spy({
      ...READY,
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
      origin: "git@github.com:NovarixHQ/Telar.git",
      upstream: true,
      ahead: 3,
    });
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
      origin: "git@github.com:NovarixHQ/Telar.git",
    });
  });

  test("an unreadable count leaves `ahead` absent rather than 0", async () => {
    const { git } = spy({ ...READY, "rev-list --count": fail("fatal: bad revision") });
    const facts = await sessionBranchFacts(git, "/repo");
    expect(facts.upstream).toBe(true);
    expect(facts).not.toHaveProperty("ahead");
  });
});

describe("pullRequestBlockedBy", () => {
  const facts = {
    repository: true,
    branch: BRANCH,
    origin: "git@github.com:NovarixHQ/Telar.git",
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
