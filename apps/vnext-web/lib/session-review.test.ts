/**
 * The reconciliation, which is the whole reason the git surface exists.
 *
 * These are the two facts no other surface in the cockpit can state: what is in
 * the diff that the transcript never mentioned, and what the transcript claimed
 * that the repository does not have.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitFileChange, SessionDiff } from "@telar/engine-client";
import { describeReview, reconcileReview } from "./session-review";

const diff = (files: GitFileChange[], totals: { added?: number; removed?: number } = {}): SessionDiff => ({
  repository: true,
  workspacePath: "/repo",
  files,
  commits: [],
  linesAdded: totals.added ?? 0,
  linesRemoved: totals.removed ?? 0,
  truncated: false,
});

const file = (path: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: "modified", ...extra });

describe("reconcileReview", () => {
  test("names the files the session never mentioned", () => {
    // The whole point: `bun.lock` is in the diff and in nobody's transcript, and
    // it is about to be in the commit.
    const review = reconcileReview(diff([file("src/auth.ts"), file("bun.lock"), file("dist/app.js", { status: "untracked" })]), [
      "src/auth.ts",
    ]);
    expect(review.unreported.map((entry) => entry.path)).toEqual(["bun.lock", "dist/app.js"]);
    expect(review.rows.map((row) => row.reported)).toEqual([true, false, false]);
  });

  test("names what the transcript claimed and the repository does not have", () => {
    // A file edited and then reverted. Not a problem, and a very different
    // report from "the agent did nothing".
    const review = reconcileReview(diff([file("src/auth.ts")]), ["src/auth.ts", "src/scratch.ts"]);
    expect(review.settled).toEqual(["src/scratch.ts"]);
    expect(review.unreported).toEqual([]);
  });

  test("a rename counts as reported under either of its names", () => {
    // The journal records the write under the NEW path; git files the row under
    // the new path and carries the old one. Matching only one would make every
    // rename read as an unreported side effect.
    const renamed = file("src/new.ts", { status: "renamed", renamedFrom: "src/old.ts" });
    expect(reconcileReview(diff([renamed]), ["src/new.ts"]).unreported).toEqual([]);
    expect(reconcileReview(diff([renamed]), ["src/old.ts"]).unreported).toEqual([]);
    // And the old path is not then reported as settled — the file did not vanish.
    expect(reconcileReview(diff([renamed]), ["src/old.ts"]).settled).toEqual([]);
  });

  test("a clean tree with a full transcript is every claim settled, not an empty review", () => {
    // What a session that committed its own work looks like: nothing on disk to
    // review, and the transcript is not evidence of a lie.
    const review = reconcileReview(diff([]), ["src/a.ts", "src/b.ts"]);
    expect(review.filesChanged).toBe(0);
    expect(review.settled).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("describeReview", () => {
  test("omits a count of zero rather than printing it", () => {
    // A deletions-only change is not "+0 −40"; a binary-only change has neither
    // figure, and inventing zeros would state a measurement git never made.
    expect(describeReview(reconcileReview(diff([file("a")], { removed: 40 }), []))).toBe("1 file −40");
    expect(describeReview(reconcileReview(diff([file("a"), file("b")], { added: 3, removed: 1 }), []))).toBe("2 files +3 −1");
    expect(describeReview(reconcileReview(diff([file("a", { binary: true })]), []))).toBe("1 file");
  });
});
