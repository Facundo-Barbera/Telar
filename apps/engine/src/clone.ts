/**
 * CLONING A REPOSITORY THE COCKPIT NAMED, so the Sources palette can offer
 * "Git URL" and "GitHub repository" beside "Local folder".
 *
 * WHY THE ENGINE OWNS IT. Registering a project has always needed a directory
 * that already exists, which left "I have a URL and no checkout yet" as a step
 * you did in a terminal before Telar could help. A browser cannot run `git` and
 * cannot name a path on disk; the engine already holds a bounded, injectable git
 * runner (see `worktree.ts`), so this is the only party that can do it.
 *
 * IT IS A MUTATION, AND IT OBEYS THE SAME RULE THE OTHER ONE DOES (`git.ts`'s
 * header): a human pressed a button, it is additive, and it is recoverable. A
 * clone only ever CREATES a directory — it refuses an existing target rather than
 * merging into it — so undoing it is deleting a folder nothing else has touched.
 *
 * WHAT IT WILL NOT DO:
 *   - Write outside `parent`. The target is one path segment joined onto it, and
 *     the segment is derived here rather than taken from the caller, so no URL can
 *     steer the write up the tree.
 *   - Take a URL that could be read as an OPTION. `git clone --upload-pack=…`
 *     runs a command of the attacker's choosing, and a leading `-` is the whole
 *     tell; `--` before the operands is the belt, this check is the braces.
 *   - Overwrite. An existing target is a conflict, never a merge.
 *
 * NO STREAMING PROGRESS, deliberately for now. A clone reports itself when it
 * lands or when it fails, and the palette's row can say "Cloning…" without the
 * engine growing a job store for it. `--progress` output would need one.
 */
import fs from "node:fs";
import path from "node:path";
import type { AsyncGitRunner, GitRunner } from "./worktree.js";

/** A clone is a network operation on somebody else's server. The read timeouts
 *  in `worktree.ts` are sized for a local `rev-parse`; a cold clone of a large
 *  repository over a slow link is minutes, and killing it at thirty seconds
 *  would make the feature look broken on exactly the repositories it matters
 *  most for. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

export type CloneFailure = { code: "invalid_request" | "conflict" | "failed"; message: string };
export type CloneOutcome = { root: string } | CloneFailure;

export function isCloneFailure(outcome: CloneOutcome): outcome is CloneFailure {
  return "code" in outcome;
}

/**
 * `owner/repo` typed into the palette, expanded to the URL it obviously means.
 *
 * ONLY THE BARE TWO-SEGMENT FORM, and only when it carries no scheme, no host and
 * no `@` — anything else is already a URL or already wrong, and guessing GitHub
 * for `gitlab.com/x/y` would clone a repository the reader did not name.
 */
export function githubShorthand(input: string): string | undefined {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? `https://github.com/${trimmed}.git` : undefined;
}

/**
 * The folder a clone of this URL lands in — `git clone`'s own rule, written out.
 *
 * git takes the last non-empty path segment, drops a trailing `.git`, and that is
 * the directory. Reimplementing it here rather than letting git choose is what
 * lets the caller be TOLD the path before the child runs, so the registration
 * afterwards does not have to go looking for what appeared.
 */
export function repoFolderName(url: string): string | undefined {
  const withoutQuery = url.trim().replace(/[?#].*$/, "");
  // `git@github.com:owner/repo.git` — scp syntax, whose separator is a colon.
  const tail = withoutQuery.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = tail.replace(/\.git$/, "").trim();
  // No separators, no traversal, nothing that reads as a hidden file: the name
  // is joined onto a directory the user picked, and it is the only untrusted
  // part of that path.
  return name && !name.startsWith(".") && !/[/\\]/.test(name) ? name : undefined;
}

/**
 * Clone `url` into a new folder under `parent`, and answer where it landed.
 *
 * A FAILURE IS A VALUE, not a throw: every arm here is a sentence the palette
 * shows in its own row, and the four of them (a URL that is not one, a parent
 * that is not a directory, a target that already exists, and git's own stderr)
 * read very differently to the person who pressed the button.
 *
 * ASYNC, AND THE STORE HANDS IT THE POOLED RUNNER. This used to run through
 * the synchronous one, so a clone — minutes, by `CLONE_TIMEOUT_MS`'s own
 * reckoning — was minutes of a daemon that answered nobody.
 */
export async function cloneRepository(git: GitRunner | AsyncGitRunner, input: { url: string; parent: string }): Promise<CloneOutcome> {
  // ONE RULE, ONE PLACE. The palette lets somebody type `owner/repo`, and
  // expanding it here rather than there means the cockpit never has to hold an
  // opinion about which forge a bare pair belongs to.
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

  // `--` ends the options, so even a URL that slipped the check above is an
  // operand. The cwd is the parent, so a relative target could not escape it
  // either; it is absolute anyway, which is what the register call needs.
  const result = await git(parentRoot, ["clone", "--", url, target], { timeoutMs: CLONE_TIMEOUT_MS });
  if (result.status !== 0) {
    return { code: "failed", message: (result.stderr || result.stdout).trim() || `git clone exited with ${result.status}` };
  }
  // A runner that answered 0 without producing a checkout is a stub or a broken
  // git; either way the registration that follows would fail with a worse
  // sentence than this one.
  if (!fs.existsSync(target)) return { code: "failed", message: `git clone reported success but ${target} is not there` };
  return { root: target };
}
