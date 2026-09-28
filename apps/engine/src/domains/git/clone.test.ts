import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { cloneRepository, githubShorthand, isCloneFailure, repoFolderName, CLONE_TIMEOUT_MS } from "./clone";
import type { GitRunner } from "../../worktree";

const roots: string[] = [];
function scratch(): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telar-clone-")));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Call = { cwd: string; args: string[]; timeoutMs?: number };

function stubGit(options: { status?: number; stderr?: string; create?: boolean } = {}) {
  const calls: Call[] = [];
  const run: GitRunner = (cwd, args, opts) => {
    calls.push({ cwd, args, ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
    const status = options.status ?? 0;
    if (status === 0 && options.create !== false) mkdirSync(args[args.length - 1], { recursive: true });
    return { status, stdout: "", stderr: options.stderr ?? "" };
  };
  return { run, calls };
}

describe("repoFolderName", () => {
  test("git's own rule: the last segment, minus `.git`", () => {
    expect(repoFolderName("https://github.com/owner/repo.git")).toBe("repo");
    expect(repoFolderName("https://github.com/owner/repo")).toBe("repo");
    expect(repoFolderName("https://example.com/deep/path/thing.git/")).toBe("thing");
    expect(repoFolderName("git@github.com:owner/repo.git")).toBe("repo");
    expect(repoFolderName("ssh://git@example.com:2222/owner/repo.git")).toBe("repo");
    expect(repoFolderName("https://example.com/owner/repo.git?ref=main")).toBe("repo");
  });

  test("a name that could steer the write out of the parent folder is refused", () => {
    expect(repoFolderName("https://example.com/owner/..")).toBeUndefined();
    expect(repoFolderName("https://example.com/owner/.hidden")).toBeUndefined();
    expect(repoFolderName("")).toBeUndefined();
    expect(repoFolderName("   ")).toBeUndefined();
  });
});

describe("githubShorthand", () => {
  test("`owner/repo` is the one shorthand, and only when it is bare", () => {
    expect(githubShorthand("NovarixHQ/Telar")).toBe("https://github.com/NovarixHQ/Telar.git");
    expect(githubShorthand(" owner/repo.git ")).toBe("https://github.com/owner/repo.git");
  });

  test("anything already a URL is left alone — guessing GitHub would clone the wrong host", () => {
    expect(githubShorthand("gitlab.com/owner/repo")).toBeUndefined();
    expect(githubShorthand("https://github.com/owner/repo")).toBeUndefined();
    expect(githubShorthand("git@github.com:owner/repo.git")).toBeUndefined();
    expect(githubShorthand("owner")).toBeUndefined();
  });
});

describe("cloneRepository", () => {
  test("it clones into the parent and answers where it landed", async () => {
    const parent = scratch();
    const git = stubGit();
    const outcome = await cloneRepository(git.run, { url: "https://github.com/owner/repo.git", parent });
    expect(isCloneFailure(outcome)).toBe(false);
    expect(outcome).toEqual({ root: path.join(parent, "repo") });
    expect(existsSync(path.join(parent, "repo"))).toBe(true);
  });

  test("`--` ends the options, and the clone gets a clone-sized deadline", async () => {
    const parent = scratch();
    const git = stubGit();
    await cloneRepository(git.run, { url: "https://github.com/owner/repo.git", parent });
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0].args).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);
    expect(git.calls[0].timeoutMs).toBe(CLONE_TIMEOUT_MS);
    expect(CLONE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("`owner/repo` is expanded here, so the cockpit holds no opinion about forges", async () => {
    const parent = scratch();
    const git = stubGit();
    const outcome = await cloneRepository(git.run, { url: "NovarixHQ/Telar", parent });
    expect(outcome).toEqual({ root: path.join(parent, "Telar") });
    expect(git.calls[0].args[2]).toBe("https://github.com/NovarixHQ/Telar.git");
  });

  test("a URL that reads as an option never reaches git", async () => {
    const parent = scratch();
    const git = stubGit();
    const outcome = await cloneRepository(git.run, { url: "--upload-pack=touch /tmp/pwned", parent });
    expect(outcome).toEqual({ code: "invalid_request", message: "a repository URL cannot start with '-'" });
    expect(git.calls).toHaveLength(0);
  });

  test("an existing target is a conflict, never a merge", async () => {
    const parent = scratch();
    mkdirSync(path.join(parent, "repo"));
    const git = stubGit();
    const outcome = await cloneRepository(git.run, { url: "https://github.com/owner/repo.git", parent });
    expect(isCloneFailure(outcome) && outcome.code).toBe("conflict");
    expect(git.calls).toHaveLength(0);
  });

  test("a parent that is not an existing absolute directory is refused before git runs", async () => {
    const git = stubGit();
    expect(await cloneRepository(git.run, { url: "https://x/y/z.git", parent: "relative/path" })).toEqual({
      code: "invalid_request",
      message: "the parent folder must be an absolute path",
    });
    expect(await cloneRepository(git.run, { url: "https://x/y/z.git", parent: "/no/such/folder/anywhere" })).toEqual({
      code: "invalid_request",
      message: "the parent folder must be an existing directory",
    });
    expect(git.calls).toHaveLength(0);
  });

  test("git's own stderr is the sentence, because it is the one that says why", async () => {
    const parent = scratch();
    const git = stubGit({ status: 128, stderr: "fatal: repository 'https://x/y/z.git' not found\n" });
    const outcome = await cloneRepository(git.run, { url: "https://x/y/z.git", parent });
    expect(outcome).toEqual({ code: "failed", message: "fatal: repository 'https://x/y/z.git' not found" });
  });

  test("a success with no checkout behind it is reported as a failure", async () => {
    const parent = scratch();
    const git = stubGit({ create: false });
    const outcome = await cloneRepository(git.run, { url: "https://github.com/owner/repo.git", parent });
    expect(isCloneFailure(outcome) && outcome.code).toBe("failed");
    expect(isCloneFailure(outcome) && outcome.message).toContain("is not there");
  });
});
