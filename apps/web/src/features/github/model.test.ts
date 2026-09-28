// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitHubCheck, GitOverview } from "@telar/engine-client";
import { clearChip, githubQuery, hasFailed, isNotable, issueSessionStart, linkVerb, listCount, toggleLabel } from "./model";

const issue = { number: 695, title: "Issue → session: a row action", url: "https://github.com/o/r/issues/695" };

const git = (over: Partial<GitOverview> = {}): GitOverview => ({
  repository: true,
  branch: "main",
  dirtyFiles: 0,
  worktrees: [],
  availability: "available",
  ...over,
});

describe("when a worktree can be cut", () => {
  test("it opens the project's canvas with the worktree armed from the remote's default branch", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", git: git({ defaultBase: "origin/main" }) });

    expect(start).toMatchObject({ ok: true, baseRef: "origin/main" });
    expect(start.ok && start.href).toBe("/projects/project_1/sessions/new?base=origin%2Fmain");
  });

  test("the first message is the row's own reference, so a press and a drag produce the same session", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", git: git() });

    expect(start.ok && start.text).toBe('#695 "Issue → session: a row action" (https://github.com/o/r/issues/695)');
  });

  test("a repository with no remote-tracking state is cut from HEAD, which is what absent has always meant", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", git: git({ defaultBase: undefined }) });

    expect(start).toMatchObject({ ok: true, baseRef: "HEAD" });
    expect(start.ok && start.href).toBe("/projects/project_1/sessions/new?base=HEAD");
  });

  test("the canvas stays on the Mac the project is on", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", hostId: "host_air", git: git({ defaultBase: "origin/main" }) });

    expect(start.ok && start.href).toBe("/hosts/host_air/projects/project_1/sessions/new?base=origin%2Fmain");
  });
});

describe("when it cannot", () => {
  test("a drive that is not connected is named, with the one thing that fixes it", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", projectName: "TelarVR Work", git: git({ availability: "unmounted" }) });

    expect(start).toEqual({
      ok: false,
      reason: "The drive holding TelarVR Work is not connected. Plug it back in and this will work again.",
    });
  });

  test("a folder that is gone says so, rather than blaming git", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", projectName: "Exoplanets", git: git({ availability: "missing" }) });

    expect(start).toEqual({
      ok: false,
      reason: "The folder for Exoplanets is not on this machine any more, so there is nowhere to cut a worktree.",
    });
  });

  test("the disk is asked about before git, so a repository in somebody's bag is never called 'not a repository'", () => {
    const start = issueSessionStart({
      issue,
      projectId: "project_1",
      projectName: "TelarVR Work",
      git: git({ repository: false, branch: undefined, availability: "unmounted" }),
    });

    expect(start.ok).toBe(false);
    expect(!start.ok && start.reason).toContain("drive holding TelarVR Work is not connected");
  });

  test("a directory that is not a repository has no worktree to give", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", projectName: "Scratch", git: git({ repository: false }) });

    expect(start).toEqual({
      ok: false,
      reason: "Scratch is not a git repository, so a session on #695 cannot have a worktree of its own.",
    });
  });

  test("a checkout that could not be read is a refusal, not a green light — and it carries the engine's own words", () => {
    const start = issueSessionStart({
      issue,
      projectId: "project_1",
      projectName: "Exoplanets",
      unreadable: "The engine adapter returned an invalid response.",
    });

    expect(start).toEqual({
      ok: false,
      reason: "Telar could not read Exoplanets's checkout, so it did not cut a worktree. The engine adapter returned an invalid response.",
    });
  });

  test("a read that failed without saying why still refuses in a whole sentence", () => {
    const start = issueSessionStart({ issue, projectId: "project_1" });

    expect(start).toEqual({ ok: false, reason: "Telar could not read this project's checkout, so it did not cut a worktree." });
  });
});

describe("the list filter", () => {
  const filter = { state: "open" as const, assignee: "ada", author: "grace", milestone: "Wave 1", labels: ["bug"] };

  test("pull requests send no milestone, because gh cannot filter them by one", () => {
    expect(githubQuery("pulls", filter)).toEqual({ pulls: { state: "open", assignee: "ada", author: "grace", labels: ["bug"] } });
    expect(githubQuery("issues", filter)).toEqual({ issues: filter });
  });

  test("a label toggles, and a chip clears only its own facet", () => {
    expect(toggleLabel(filter, "bug").labels).toEqual([]);
    expect(toggleLabel(filter, "ui").labels).toEqual(["bug", "ui"]);
    expect(clearChip(filter, { key: "l:bug", label: "bug", clear: "label", value: "bug" })).toEqual({ ...filter, labels: [] });
    expect(clearChip(filter, { key: "a:ada", label: "@ada", clear: "assignee" })).toEqual({ ...filter, assignee: undefined });
  });

  test("a full page admits it may be truncated", () => {
    expect(listCount(0, "issues")).toBe("no issues");
    expect(listCount(1, "pull requests")).toBe("1 pull request");
    expect(listCount(50, "issues")).toBe("50+ issues");
  });
});

describe("checks and links", () => {
  const check = (status: string, conclusion?: string) => ({ name: "ci", status, ...(conclusion ? { conclusion } : {}) }) as GitHubCheck;

  test("a running or failing check is notable; a skipped one is not", () => {
    expect(isNotable(check("IN_PROGRESS"))).toBe(true);
    expect(isNotable(check("COMPLETED", "FAILURE"))).toBe(true);
    expect(isNotable(check("COMPLETED", "SKIPPED"))).toBe(false);
    expect(hasFailed(check("COMPLETED", "TIMED_OUT"))).toBe(true);
    expect(hasFailed(check("IN_PROGRESS"))).toBe(false);
  });

  test("only a closed issue says it was closed by a pull request", () => {
    expect(linkVerb(true, "OPEN")).toBe("closes");
    expect(linkVerb(false, "CLOSED")).toBe("closed by");
    expect(linkVerb(false, "OPEN")).toBe("will close with");
  });
});
