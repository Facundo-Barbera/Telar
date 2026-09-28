import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsyncGitRunner, defaultGitRunner } from "../src/platform/git/runner";
import { createSessionWorktreeAsync, prepareSessionWorktree } from "../src/domains/worktrees";

const roots: string[] = [];
export const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/** For an `afterEach`: removes every directory `tmp` handed out. */
export const removeTmp = (): void => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
};

// Knows a Claude default, so a claim is not withheld waiting for a model list nobody reads here.
export const engineHome = (prefix: string): string => {
  const directory = tmp(prefix);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

/** A git pool of the calling file's own, never the shared singleton, and the whole cut the way `createSession` makes it. */
export function worktreeFixtures() {
  const poolGit = createAsyncGitRunner();
  async function cutWorktree(input: {
    engineRoot: string;
    projectRoot: string;
    sessionId: string;
    baseRef?: string;
    branchSlug?: string;
    branchName?: string;
  }): Promise<{ path: string; branch: string; baseRef: string }> {
    const { plan, baseSha } = prepareSessionWorktree(defaultGitRunner, input);
    return createSessionWorktreeAsync(poolGit, { engineRoot: input.engineRoot, projectRoot: input.projectRoot, plan, baseSha });
  }
  return { poolGit, cutWorktree };
}

// Polls `done` until it holds or `boundMs` elapses, so a fixture's startup never shares the bound being measured.
export const until = async (done: () => boolean, boundMs: number): Promise<boolean> => {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline && !done()) await new Promise(resolve => setTimeout(resolve, 25));
  return done();
};

/** A throwaway repository with one commit, so `HEAD` resolves. */
export function repo(): string {
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
