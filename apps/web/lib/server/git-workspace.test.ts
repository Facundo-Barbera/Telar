import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkoutGitBranch,
  commitGit,
  readGitDiff,
  readGitWorkspaceStatus,
  safeGitRef,
  safeRepoPath,
  setGitStaged,
} from "./git-workspace";

const roots: string[] = [];

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-git-workspace-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Telar Test"]);
  git(root, ["config", "user.email", "telar@example.test"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\ntwo\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("git workspace contract", () => {
  test("rejects paths and refs that can escape or become options", () => {
    expect(safeRepoPath("src/app.ts")).toBe("src/app.ts");
    expect(safeRepoPath("../secret")).toBeNull();
    expect(safeRepoPath("/tmp/secret")).toBeNull();
    expect(safeGitRef("feature/browser-control")).toBe("feature/browser-control");
    expect(safeGitRef("--upload-pack=evil")).toBeNull();
    expect(safeGitRef("main..evil")).toBeNull();
  });

  test("reports staged, unstaged, untracked, and line totals", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "tracked.txt"), "one\nchanged\nthree\n");
    fs.writeFileSync(path.join(root, "new.txt"), "alpha\nbeta\n");
    await setGitStaged(root, ["tracked.txt"], true);
    fs.appendFileSync(path.join(root, "tracked.txt"), "after-stage\n");

    const status = await readGitWorkspaceStatus(root);
    expect(status.branch).toBe("main");
    expect(status.summary.files).toBe(2);
    expect(status.summary.staged).toBe(1);
    expect(status.summary.unstaged).toBe(1);
    expect(status.summary.untracked).toBe(1);
    expect(status.summary.additions).toBeGreaterThanOrEqual(5);
    expect(status.files.find((file) => file.path === "tracked.txt")).toMatchObject({
      staged: true,
      unstaged: true,
    });
  });

  test("returns capped, path-scoped patches including untracked files", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "new.txt"), "alpha\nbeta\n");
    const diff = await readGitDiff(root, "all", "new.txt");
    expect(diff.patch).toContain("new.txt");
    expect(diff.patch).toContain("+alpha");
    expect(diff.truncated).toBe(false);
  });

  test("guards branch switching and can create a branch after committing", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "new.txt"), "alpha\n");
    await expect(checkoutGitBranch(root, "feature/test", true)).rejects.toThrow("Commit or stash");
    await setGitStaged(root, ["new.txt"], true);
    await commitGit(root, "add new file");
    await checkoutGitBranch(root, "feature/test", true);
    expect(git(root, ["branch", "--show-current"]).trim()).toBe("feature/test");
  });
});
