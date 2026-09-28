import type { GitCommitEntry, GitPushRefusal, GitPushResult } from "@telar/engine-client";
import { GIT_LOG_FORMAT, parseGitLog } from "../../platform/git/parse";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";

export async function commitSessionWork(
  git: AsyncGitRunner,
  input: { cwd: string; message: string },
): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
  const inside = await git(input.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.timedOut) return { committed: false, reason: "git did not answer in time — try again." };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { committed: false, reason: "This session's workspace is not a git repository." };
  }
  const staged = await git(input.cwd, ["add", "-A"]);
  if (staged.status !== 0) {
    return { committed: false, reason: staged.stderr.trim() || "git could not stage this session's changes." };
  }
  if ((await git(input.cwd, ["diff", "--cached", "--quiet"])).status === 0) {
    return { committed: false, reason: "Nothing to commit — this session's checkout matches its last commit." };
  }
  const committed = await git(input.cwd, ["commit", "-m", input.message]);
  if (committed.status !== 0) {
    return { committed: false, reason: committed.stderr.trim() || committed.stdout.trim() || "git refused the commit." };
  }
  const entry = parseGitLog((await git(input.cwd, ["log", "-1", `--format=${GIT_LOG_FORMAT}`])).stdout)[0];
  return { committed: true, ...(entry ? { commit: entry } : {}) };
}

export const PUSH_TIMEOUT_MS = 60_000;

export function pushArgv(branch: string): string[] {
  return ["push", "--set-upstream", "origin", branch];
}

export const PUSH_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

export type SessionBranchFacts = {
  repository: boolean;
  timedOut?: true;
  branch?: string;
  origin?: string;
  upstream?: boolean;
  ahead?: number;
};

export async function sessionBranchFacts(git: AsyncGitRunner, cwd: string): Promise<SessionBranchFacts> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.timedOut) return { repository: false, timedOut: true };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { repository: false };

  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.timedOut) return { repository: true, timedOut: true };
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const remote = await git(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote.timedOut) return { repository: true, timedOut: true, ...(branch ? { branch } : {}) };
  const origin = remote.status === 0 ? remote.stdout.trim() : "";

  if (!branch || !origin) {
    return { repository: true, ...(branch ? { branch } : {}), ...(origin ? { origin } : {}) };
  }

  const tracking = `refs/remotes/origin/${branch}`;
  const exists = await git(cwd, ["rev-parse", "--verify", "--quiet", tracking]);
  if (exists.timedOut) return { repository: true, branch, origin, timedOut: true };
  if (exists.status !== 0) return { repository: true, branch, origin, upstream: false };

  const counted = await git(cwd, ["rev-list", "--count", `${tracking}..HEAD`]);
  if (counted.timedOut) return { repository: true, branch, origin, upstream: true, timedOut: true };
  const ahead = counted.status === 0 ? Number.parseInt(counted.stdout.trim(), 10) : Number.NaN;
  return { repository: true, branch, origin, upstream: true, ...(Number.isFinite(ahead) ? { ahead } : {}) };
}

export function classifyPushFailure(result: Pick<GitResult, "stdout" | "stderr">): { refusal: GitPushRefusal; message?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  if (
    text.includes("terminal prompts disabled") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("authentication failed") ||
    text.includes("permission denied (publickey)") ||
    text.includes("invalid username or password") ||
    text.includes("no supported authentication")
  ) {
    return { refusal: "auth", ...carry };
  }
  if (
    text.includes("[remote rejected]") ||
    text.includes("hook declined") ||
    text.includes("protected branch") ||
    text.includes("denied to") ||
    text.includes("http 403") ||
    text.includes("error: 403") ||
    text.includes("write access") ||
    text.includes("permission to")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  if (
    text.includes("[rejected]") ||
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("updates were rejected")
  ) {
    return { refusal: "rejected", ...carry };
  }
  if (text.includes("does not appear to be a git repository") || text.includes("no such remote") || text.includes("does not exist")) {
    return { refusal: "no_remote", ...carry };
  }
  return { refusal: "failed", ...carry };
}

export function pushMovedNothing(result: Pick<GitResult, "stdout" | "stderr">): boolean {
  return `${result.stderr}\n${result.stdout}`.toLowerCase().includes("everything up-to-date");
}

export async function pushSessionBranch(
  git: AsyncGitRunner,
  input: {
    cwd: string;
    mode: "local" | "worktree";
    branch?: string;
  },
): Promise<GitPushResult> {
  if (input.mode === "local") {
    return {
      pushed: false,
      refusal: "local_checkout",
      message: "This session works in the project's own checkout, which it shares with your editor. There is no session branch to publish.",
    };
  }
  const branch = input.branch?.trim();
  if (!branch) {
    return { pushed: false, refusal: "not_session_branch", message: "This session has no branch of its own recorded." };
  }

  const facts = await sessionBranchFacts(git, input.cwd);
  const refusal = refuseFromFacts(facts, branch);
  if (refusal) return refusal;

  const push = await git(input.cwd, pushArgv(branch), { timeoutMs: PUSH_TIMEOUT_MS, env: PUSH_ENV });
  if (push.timedOut) {
    return { pushed: false, refusal: "timeout", message: `The push did not finish within ${PUSH_TIMEOUT_MS / 1_000}s and was stopped.` };
  }
  if (push.status !== 0) return { pushed: false, ...classifyPushFailure(push) };
  if (pushMovedNothing(push)) {
    return { pushed: false, refusal: "nothing_to_push", message: `origin already has every commit on ${branch}.` };
  }
  return {
    pushed: true,
    branch,
    ...(facts.ahead === undefined ? {} : { commits: facts.ahead }),
    ...(facts.upstream === false ? { created: true } : {}),
  };
}

function refuseFromFacts(facts: SessionBranchFacts, branch: string): { pushed: false; refusal: GitPushRefusal; message: string } | undefined {
  if (facts.timedOut) return { pushed: false, refusal: "timeout", message: "git did not answer in time — try again." };
  if (!facts.repository) return { pushed: false, refusal: "not_repository", message: "This session's workspace is not a git repository." };
  if (!facts.origin) {
    return { pushed: false, refusal: "no_remote", message: "This checkout has no origin, so there is nowhere to push it." };
  }
  if (facts.branch !== branch) {
    return {
      pushed: false,
      refusal: "not_session_branch",
      message: facts.branch
        ? `This checkout is on ${facts.branch}, not on this session's branch ${branch}.`
        : `This checkout is not on a branch, so ${branch} is not what would be pushed.`,
    };
  }
  if (facts.upstream === true && facts.ahead === 0) {
    return { pushed: false, refusal: "nothing_to_push", message: `origin already has every commit on ${branch}.` };
  }
  return undefined;
}

export function pullRequestBlockedBy(facts: SessionBranchFacts, branch: string): { refusal: GitPushRefusal; message: string } | undefined {
  const shared = refuseFromFacts(facts, branch);
  if (shared) {
    if (shared.refusal === "nothing_to_push") return undefined;
    return { refusal: shared.refusal, message: shared.message };
  }
  return undefined;
}

