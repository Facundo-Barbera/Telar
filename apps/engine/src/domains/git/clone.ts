import fs from "node:fs";
import path from "node:path";
import type { AsyncGitRunner, GitRunner } from "../../worktree";

export const CLONE_TIMEOUT_MS = 10 * 60_000;

export type CloneFailure = { code: "invalid_request" | "conflict" | "failed"; message: string };
export type CloneOutcome = { root: string } | CloneFailure;

export function isCloneFailure(outcome: CloneOutcome): outcome is CloneFailure {
  return "code" in outcome;
}

export function githubShorthand(input: string): string | undefined {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? `https://github.com/${trimmed}.git` : undefined;
}

export function repoFolderName(url: string): string | undefined {
  const withoutQuery = url.trim().replace(/[?#].*$/, "");
  const tail = withoutQuery.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = tail.replace(/\.git$/, "").trim();
  return name && !name.startsWith(".") && !/[/\\]/.test(name) ? name : undefined;
}

export async function cloneRepository(git: GitRunner | AsyncGitRunner, input: { url: string; parent: string }): Promise<CloneOutcome> {
  const url = githubShorthand(input.url) ?? input.url.trim();
  if (!url) return { code: "invalid_request", message: "a repository URL is required" };
  if (url.startsWith("-")) return { code: "invalid_request", message: "a repository URL cannot start with '-'" };
  const parent = input.parent.trim();
  if (!path.isAbsolute(parent)) return { code: "invalid_request", message: "the parent folder must be an absolute path" };
  let parentRoot: string;
  try {
    parentRoot = fs.realpathSync.native(parent);
    if (!fs.statSync(parentRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    return { code: "invalid_request", message: "the parent folder must be an existing directory" };
  }

  const name = repoFolderName(url);
  if (!name) return { code: "invalid_request", message: `no folder name could be read out of ${url}` };
  const target = path.join(parentRoot, name);
  if (fs.existsSync(target)) return { code: "conflict", message: `${target} already exists — clone it somewhere else, or register it as it is` };

  const result = await git(parentRoot, ["clone", "--", url, target], { timeoutMs: CLONE_TIMEOUT_MS });
  if (result.status !== 0) {
    return { code: "failed", message: (result.stderr || result.stdout).trim() || `git clone exited with ${result.status}` };
  }
  if (!fs.existsSync(target)) return { code: "failed", message: `git clone reported success but ${target} is not there` };
  return { root: target };
}
