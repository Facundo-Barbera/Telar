import type { GitChangeStatus, GitFileChange, GitFilePatch, GitOverview, GitReadFailure, GitRefEntry, SessionDiff } from "@telar/engine-client";
import { countDirty, GIT_LOG_FORMAT, parseAheadBehind, parseGitLog, parseNameStatus, parseNumstat, parseUntracked, parseWorktreeList } from "../../platform/git/parse";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";

function failureOf(result: { status: number; timedOut?: true }): GitReadFailure | undefined {
  if (result.timedOut) return "timeout";
  return result.status === 0 ? undefined : "failed";
}

function worseFailure(...failures: (GitReadFailure | undefined)[]): GitReadFailure | undefined {
  if (failures.includes("timeout")) return "timeout";
  return failures.find((failure) => failure !== undefined);
}

export type GitRefListing = {
  refs: GitRefEntry[];
  incomplete?: GitReadFailure;
};

const MAX_REVIEW_FILES = 300;

const EMPTY: GitOverview = { repository: false, dirtyFiles: 0, worktrees: [] };

function refuseTimedOutProbe(probe: { stderr: string; timedOut?: true }, what: string): void {
  if (probe.timedOut) throw new Error(probe.stderr || `${what} timed out`);
}

function resolveDiffBase(
  baseRef: string | undefined,
  verify: GitResult | undefined,
): { base?: string; baseUnverified?: GitReadFailure } {
  if (!baseRef || !verify) return {};
  if (verify.status === 0) return { base: baseRef };
  return verify.timedOut ? { base: baseRef, baseUnverified: "timeout" } : {};
}

function assembleDiff(
  cwd: string,
  reads: {
    head: GitResult;
    base?: string;
    baseUnverified?: GitReadFailure;
    numstat: GitResult;
    nameStatus: GitResult;
    status: GitResult;
    log?: GitResult;
    tracking: GitResult;
  },
): SessionDiff {
  const raw = reads.head.status === 0 ? reads.head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const statuses = reads.nameStatus.status === 0 ? parseNameStatus(reads.nameStatus.stdout) : new Map<string, GitChangeStatus>();
  const tracked: GitFileChange[] = (reads.numstat.status === 0 ? parseNumstat(reads.numstat.stdout) : []).map((entry) => ({
    path: entry.path,
    status: statuses.get(entry.path) ?? "modified",
    ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
    ...(entry.added === undefined ? {} : { linesAdded: entry.added }),
    ...(entry.removed === undefined ? {} : { linesRemoved: entry.removed }),
    ...(entry.binary ? { binary: true } : {}),
  }));
  const untracked: GitFileChange[] = (reads.status.status === 0 ? parseUntracked(reads.status.stdout) : []).map((path) => ({
    path,
    status: "untracked" as const,
  }));

  const filesIncomplete = worseFailure(failureOf(reads.numstat), failureOf(reads.nameStatus), failureOf(reads.status));
  const commits = reads.log?.status === 0 ? parseGitLog(reads.log.stdout) : [];
  const commitsIncomplete = reads.log ? failureOf(reads.log) : undefined;

  const divergence = reads.tracking.status === 0 ? parseAheadBehind(reads.tracking.stdout) : undefined;

  const all = [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
  return {
    repository: true,
    workspacePath: cwd,
    ...(branch ? { branch } : {}),
    ...(reads.base ? { base: reads.base } : {}),
    ...(reads.baseUnverified ? { baseUnverified: reads.baseUnverified } : {}),
    ...divergence,
    files: all.slice(0, MAX_REVIEW_FILES),
    ...(filesIncomplete ? { filesIncomplete } : {}),
    commits,
    ...(commitsIncomplete ? { commitsIncomplete } : {}),
    linesAdded: all.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0),
    linesRemoved: all.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0),
    truncated: all.length > MAX_REVIEW_FILES,
  };
}

function paths(target: string, renamedFrom?: string): string[] {
  return renamedFrom && renamedFrom !== target ? [literal(renamedFrom), literal(target)] : [literal(target)];
}

function renameArgs(renamedFrom?: string): string[] {
  return renamedFrom ? ["--find-renames"] : [];
}

function literal(target: string): string {
  return `:(literal)${target}`;
}

const RAW_PATHS = ["-c", "core.quotePath=false"] as const;

function patchWhitespaceArgs(ignoreWhitespace: boolean | undefined): string[] {
  return ignoreWhitespace ? ["-w", "--ignore-blank-lines"] : [];
}

function assemblePatch(result: GitResult, arm: { noIndex: boolean }): GitFilePatch {
  if (result.overflowed) return { patch: result.stdout, binary: false, incomplete: "truncated" };
  if (result.status !== 0 && !(arm.noIndex && result.status === 1)) {
    return { patch: "", binary: false, incomplete: result.timedOut ? "timeout" : "failed" };
  }
  const patch = result.stdout;
  return { patch, binary: /^Binary files .* differ$/m.test(patch) };
}

const MAX_REFS = 200;

function parseRefLines(stdout: string, kind: GitRefEntry["kind"]): GitRefEntry[] {
  const refs: GitRefEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name = "", headMark = ""] = line.split("\t");
    if (!name || name.endsWith("/HEAD")) continue;
    refs.push({ name, kind, ...(headMark.trim() === "*" ? { head: true } : {}) });
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

function joinRefHalves(local: GitRefListing, remote: GitRefListing): GitRefListing {
  const incomplete = worseFailure(local.incomplete, remote.incomplete);
  return {
    refs: [...local.refs, ...remote.refs].slice(0, MAX_REFS),
    ...(incomplete ? { incomplete } : {}),
  };
}

export function normalizeRemote(remote: string | undefined): string | undefined {
  const raw = (remote ?? "").trim();
  if (!raw) return undefined;
  const scpLike = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/.exec(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(raw);
  let authority: string;
  let path: string;
  if (withScheme) {
    const rest = withScheme[1] ?? "";
    const cut = rest.indexOf("/");
    authority = cut < 0 ? rest : rest.slice(0, cut);
    path = cut < 0 ? "" : rest.slice(cut + 1);
  } else if (scpLike) {
    authority = scpLike[2] ?? "";
    path = scpLike[3] ?? "";
  } else {
    return undefined;
  }
  const host = (authority.split("@").pop() ?? "").replace(/:\d+$/, "");
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (!host || segments.length === 0) return undefined;
  const last = segments.length - 1;
  segments[last] = (segments[last] ?? "").replace(/\.git$/i, "");
  if (!segments[last]) return undefined;
  return [host, ...segments].join("/").toLowerCase();
}

export async function projectRemoteAsync(git: AsyncGitRunner, projectRoot: string): Promise<string | undefined> {
  const found = await git(projectRoot, ["config", "--get", "remote.origin.url"], { timeoutMs: 5_000 });
  return found.status === 0 ? normalizeRemote(found.stdout) : undefined;
}

export async function sessionDiffAsync(git: AsyncGitRunner, input: { cwd: string; baseRef?: string; to?: string }): Promise<SessionDiff> {
  const { cwd, baseRef, to } = input;
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git review");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { repository: false, workspacePath: cwd, files: [], commits: [], linesAdded: 0, linesRemoved: 0, truncated: false };
  }

  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const { base, baseUnverified } = resolveDiffBase(baseRef, baseRef ? await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";
  const range = to ? [against, to] : [against];

  return assembleDiff(cwd, {
    head,
    ...(base ? { base } : {}),
    ...(baseUnverified ? { baseUnverified } : {}),
    numstat: await git(cwd, ["diff", "-z", "--numstat", "--find-renames", ...range, "--"]),
    nameStatus: await git(cwd, ["diff", "-z", "--name-status", "--find-renames", ...range, "--"]),
    status: to ? { status: 0, stdout: "", stderr: "" } : await git(cwd, ["status", "--porcelain", "-z", "-uall"]),
    ...(base ? { log: await git(cwd, ["log", `--format=${GIT_LOG_FORMAT}`, `${base}..${to ?? "HEAD"}`]) } : {}),
    tracking: await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  });
}

export async function sessionFilePatchAsync(
  git: AsyncGitRunner,
  input: { cwd: string; baseRef?: string; to?: string; path: string; untracked?: boolean; ignoreWhitespace?: boolean; renamedFrom?: string },
): Promise<GitFilePatch> {
  const { cwd, baseRef, path: target } = input;
  const { base } = resolveDiffBase(baseRef, baseRef ? await git(cwd, ["rev-parse", "--verify", "--quiet", baseRef]) : undefined);
  const against = base ?? "HEAD";
  const ignoring = patchWhitespaceArgs(input.ignoreWhitespace);
  const range = input.to ? [against, input.to] : [against];
  return input.untracked && !input.to
    ? assemblePatch(await git(cwd, [...RAW_PATHS, "diff", "--no-index", "--unified=3", ...ignoring, "--", "/dev/null", target]), { noIndex: true })
    : assemblePatch(
        await git(cwd, [
          ...RAW_PATHS,
          "diff",
          "--unified=3",
          ...ignoring,
          ...renameArgs(input.renamedFrom),
          ...range,
          "--",
          ...paths(target, input.renamedFrom),
        ]),
        { noIndex: false },
      );
}

export async function listGitRefsAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitRefListing> {
  const half = async (namespace: string, kind: GitRefEntry["kind"]): Promise<GitRefListing> => {
    const listed = await git(projectRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)", namespace]);
    const failure = failureOf(listed);
    return { refs: failure ? [] : parseRefLines(listed.stdout, kind), ...(failure ? { incomplete: failure } : {}) };
  };
  return joinRefHalves(await half("refs/heads", "local"), await half("refs/remotes", "remote"));
}

export async function defaultRemoteBaseAsync(git: AsyncGitRunner, projectRoot: string, listing: GitRefListing): Promise<string | undefined> {
  const pointed = await git(projectRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (pointed.status === 0) {
    const name = pointed.stdout.trim().replace(/^refs\/remotes\//, "");
    if (name && (listing.incomplete !== undefined || listing.refs.some((ref) => ref.kind === "remote" && ref.name === name))) return name;
  }
  for (const guess of ["origin/main", "origin/master"]) {
    if (listing.refs.some((ref) => ref.kind === "remote" && ref.name === guess)) return guess;
  }
  return undefined;
}

export async function gitOverviewAsync(git: AsyncGitRunner, projectRoot: string): Promise<GitOverview> {
  const inside = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  refuseTimedOutProbe(inside, "Git overview");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return EMPTY;
  const head = await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const raw = head.status === 0 ? head.stdout.trim() : "";
  const branch = raw && raw !== "HEAD" ? raw : undefined;

  const status = await git(projectRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.timedOut ? undefined : status.status === 0 ? countDirty(status.stdout) : 0;
  const tracking = await git(projectRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  const divergence = tracking.status === 0 ? parseAheadBehind(tracking.stdout) : undefined;

  const worktrees = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  const listing = await listGitRefsAsync(git, projectRoot);
  const defaultBase = await defaultRemoteBaseAsync(git, projectRoot, listing);

  return {
    repository: true,
    ...(branch ? { branch } : {}),
    ...(dirtyFiles === undefined ? {} : { dirtyFiles }),
    ...divergence,
    ...(worktrees.timedOut ? {} : { worktrees: worktrees.status === 0 ? parseWorktreeList(worktrees.stdout, projectRoot) : [] }),
    refs: listing.refs,
    ...(listing.incomplete ? { refsIncomplete: listing.incomplete } : {}),
    ...(defaultBase ? { defaultBase } : {}),
  };
}