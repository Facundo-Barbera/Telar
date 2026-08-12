import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GitDiffResponse,
  GitDiffScope,
  GitFileStatus,
  GitWorkspaceStatusResponse,
} from "@/lib/git-workspace-contract";

const execFileP = promisify(execFile);
const PATCH_LIMIT = 240_000;
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*[~^:?*\[\\\s])[^\u0000-\u001f\u007f]+$/;

type GitResult = { stdout: string; stderr: string; code: number };

async function runGit(root: string, args: string[], allowFailure = false): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    const result = {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === "number" ? failure.code : 1,
    };
    if (allowFailure) return result;
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed.`);
  }
}

export function safeRepoPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../")) return null;
  return clean === "." ? null : clean;
}

export function safeGitRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  return ref.length > 0 && ref.length <= 240 && REF_PATTERN.test(ref) ? ref : null;
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [added = "0", deleted = "0", ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    const previous = stats.get(filePath);
    stats.set(filePath, {
      additions: (previous?.additions ?? 0) + (Number(added) || 0),
      deletions: (previous?.deletions ?? 0) + (Number(deleted) || 0),
      binary: Boolean(previous?.binary || binary),
    });
  }
  return stats;
}

function mergeStats(
  target: Map<string, { additions: number; deletions: number; binary: boolean }>,
  source: Map<string, { additions: number; deletions: number; binary: boolean }>,
) {
  for (const [filePath, value] of source) {
    const previous = target.get(filePath);
    target.set(filePath, {
      additions: (previous?.additions ?? 0) + value.additions,
      deletions: (previous?.deletions ?? 0) + value.deletions,
      binary: Boolean(previous?.binary || value.binary),
    });
  }
}

async function untrackedStat(root: string, filePath: string) {
  try {
    const file = await fs.readFile(path.join(root, filePath));
    if (file.includes(0)) return { additions: 0, deletions: 0, binary: true };
    const text = file.toString("utf8");
    const additions = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { additions, deletions: 0, binary: false };
  } catch {
    return { additions: 0, deletions: 0, binary: false };
  }
}

export async function readGitWorkspaceStatus(root: string): Promise<GitWorkspaceStatusResponse> {
  const [status, stagedRaw, workingRaw, branchRaw, upstreamRaw, countsRaw] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["diff", "--cached", "--numstat", "--no-renames"]),
    runGit(root, ["diff", "--numstat", "--no-renames"]),
    runGit(root, ["branch", "--show-current"]),
    runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true),
    runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], true),
  ]);

  const stats = parseNumstat(stagedRaw.stdout);
  mergeStats(stats, parseNumstat(workingRaw.stdout));
  const fields = status.stdout.split("\0");
  const files: GitFileStatus[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const indexStatus = field[0] ?? " ";
    const worktreeStatus = field[1] ?? " ";
    const filePath = field.slice(3);
    const renamed = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    const previousPath = renamed ? fields[++index] || undefined : undefined;
    const untracked = indexStatus === "?" && worktreeStatus === "?";
    if (untracked && !stats.has(filePath)) stats.set(filePath, await untrackedStat(root, filePath));
    const stat = stats.get(filePath) ?? (previousPath ? stats.get(previousPath) : undefined);
    files.push({
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      indexStatus,
      worktreeStatus,
      staged: !untracked && indexStatus !== " ",
      unstaged: !untracked && worktreeStatus !== " ",
      untracked,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    });
  }

  const [behind = 0, ahead = 0] = countsRaw.code === 0
    ? countsRaw.stdout.trim().split(/\s+/).map((value) => Number(value) || 0)
    : [0, 0];
  return {
    branch: branchRaw.stdout.trim() || "Detached HEAD",
    upstream: upstreamRaw.code === 0 ? upstreamRaw.stdout.trim() || null : null,
    ahead,
    behind,
    files,
    summary: {
      files: files.length,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged).length,
      untracked: files.filter((file) => file.untracked).length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    },
  };
}

function capPatch(value: string): Pick<GitDiffResponse, "patch" | "truncated"> {
  if (value.length <= PATCH_LIMIT) return { patch: value, truncated: false };
  return { patch: `${value.slice(0, PATCH_LIMIT)}\n\n… diff truncated by Telar …\n`, truncated: true };
}

async function untrackedPatch(root: string, filePath: string): Promise<string> {
  const result = await runGit(
    root,
    ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", filePath],
    true,
  );
  return result.code === 0 || result.code === 1 ? result.stdout : "";
}

export async function readGitDiff(
  root: string,
  scope: GitDiffScope,
  filePath?: string,
  base?: string,
): Promise<GitDiffResponse> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (scope === "staged") args.push("--cached");
  if (scope === "compare") {
    const ref = safeGitRef(base);
    if (!ref) throw new Error("A valid comparison branch is required.");
    args.push(`${ref}...HEAD`);
  }
  if (filePath) args.push("--", filePath);
  let patch = (await runGit(root, args)).stdout;
  if (scope === "all") {
    const stagedArgs = ["diff", "--cached", "--no-ext-diff", "--no-color"];
    if (filePath) stagedArgs.push("--", filePath);
    patch = `${(await runGit(root, stagedArgs)).stdout}${patch}`;
  }
  if (filePath && !patch) {
    const status = await readGitWorkspaceStatus(root);
    if (status.files.find((file) => file.path === filePath)?.untracked) {
      patch = await untrackedPatch(root, filePath);
    }
  }
  const capped = capPatch(patch);
  return {
    scope,
    path: filePath ?? null,
    base: scope === "compare" ? base ?? null : null,
    ...capped,
    binary: patch.includes("Binary files ") || patch.includes("GIT binary patch"),
  };
}

function requirePaths(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 200) {
    throw new Error("Select between 1 and 200 repository files.");
  }
  const paths = values.map(safeRepoPath);
  if (paths.some((value) => value === null)) throw new Error("One or more file paths are invalid.");
  return paths as string[];
}

export async function setGitStaged(root: string, values: unknown, staged: boolean): Promise<void> {
  const paths = requirePaths(values);
  if (staged) await runGit(root, ["add", "--", ...paths]);
  else await runGit(root, ["restore", "--staged", "--", ...paths]);
}

export async function commitGit(root: string, message: unknown): Promise<string> {
  if (typeof message !== "string" || message.trim().length === 0 || message.length > 500) {
    throw new Error("Commit message must be between 1 and 500 characters.");
  }
  const result = await runGit(root, ["commit", "-m", message.trim()]);
  return result.stdout.trim();
}

export async function pushGit(root: string): Promise<string> {
  const branch = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("Cannot push a detached HEAD.");
  const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"], true);
  const result = upstream.code === 0
    ? await runGit(root, ["push"])
    : await runGit(root, ["push", "--set-upstream", "origin", branch]);
  return (result.stdout || result.stderr).trim();
}

export async function checkoutGitBranch(
  root: string,
  rawName: unknown,
  create: boolean,
): Promise<string> {
  const name = safeGitRef(rawName);
  if (!name) throw new Error("A valid branch name is required.");
  const status = await readGitWorkspaceStatus(root);
  if (status.summary.files > 0) throw new Error("Commit or stash changes before switching branches.");
  await runGit(root, create ? ["switch", "-c", name] : ["switch", name]);
  return name;
}
