/**
 * ISSUE → SESSION, AS A DECISION — issue #695.
 *
 * The gesture is one press, and everything interesting about it happens before
 * anything is drawn: whether a worktree can be cut at all, what it is cut from,
 * and what the first message says. Those are decided here, so they are tested
 * here — a refusal proved through a rendered string is a refusal proved twice as
 * slowly and half as clearly. What the row does with the answer is pinned in
 * `components/session/github-surface.session.test.tsx`.
 *
 * THE SENTENCES ARE PART OF THE CONTRACT, not incidental strings. #695's whole
 * constraint is that this refuses WITH THE REASON, so each arm asserts the
 * sentence a person reads. A reworded refusal should make somebody re-read the
 * wording; a refusal that quietly becomes a silence should fail.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitOverview } from "@telar/engine-client";
import { issueSessionStart } from "./issue-session";

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
    /**
     * `?base=` IS THE WHOLE MECHANISM. The cockpit seeds the base from it AND
     * flips the mode to `worktree`, which is what "armed" means here — so this
     * one query is both halves of the promise the control makes, and a href
     * without it would open a canvas that creates a session in the shared
     * checkout instead.
     */
    expect(start.ok && start.href).toBe("/projects/project_1/sessions/new?base=origin%2Fmain");
  });

  test("the first message is the row's own reference, so a press and a drag produce the same session", () => {
    const start = issueSessionStart({ issue, projectId: "project_1", git: git() });

    // Number, title and URL: the number alone is unreadable in a transcript six
    // weeks later, and the transcript is the part that has to survive.
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
    // What an unplugged drive's git read looks like: no repository, no branch,
    // nothing dirty — every field the same as an unversioned folder's. Deciding
    // on `repository` first would send the reader after the wrong problem.
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
