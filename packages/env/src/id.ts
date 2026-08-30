import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

function git(cwd: string, ...args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/** Normalize a git remote URL to a stable host/owner/repo form. */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  s = s.replace(/^git\+/, "");
  const ssh = s.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/);
  const http = s.match(/^https?:\/\/(?:[\w.-]+@)?([\w.-]+)\/(.+)$/);
  const m = http ?? ssh;
  if (!m) return s;
  const host = m[1]!.toLowerCase();
  const path = m[2]!.replace(/\.git$/, "").replace(/^\/+/, "").toLowerCase();
  return `${host}/${path}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export interface ProjectIdentity {
  id: string;
  /** Path of the primary checkout (the main worktree). */
  root: string;
  remote: string | null;
}

/**
 * Derive the stable project id for a directory inside any worktree of a repo.
 * Keyed by normalized remote URL; falls back to the primary checkout's path.
 * The id is a readable slug plus a short hash so distinct projects never collide.
 */
export function projectIdentity(cwd: string): ProjectIdentity {
  // The common dir belongs to the primary checkout even when cwd is a linked worktree.
  const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const root = commonDir ? resolve(commonDir, "..") : resolve(cwd);
  const remote = commonDir ? git(root, "remote", "get-url", "origin") : null;
  const key = remote ? normalizeRemote(remote) : root;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return { id: `${slug(basename(key)) || "project"}-${hash}`, root, remote };
}

/** The worktree root containing cwd (linked worktrees resolve to themselves, not the primary). */
export function worktreeRoot(cwd: string): string {
  return git(cwd, "rev-parse", "--show-toplevel") ?? resolve(cwd);
}
