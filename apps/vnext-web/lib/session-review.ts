/**
 * TWO WITNESSES TO THE SAME SESSION, and the interesting part is where they
 * disagree.
 *
 * The journal knows what the agent REPORTED writing: every `file_change` item
 * carries the patch its own tool produced. Git knows what is actually different
 * on disk. Neither is the whole truth:
 *
 *   - Git sees side effects nobody narrated. `bun install` rewrites a lockfile,
 *     a test run drops a snapshot, a build writes `dist/`, a formatter reflows a
 *     file the agent never opened. None of that appears in a transcript, and all
 *     of it is about to be in your commit.
 *   - The journal sees work that no longer exists. A file edited and then
 *     reverted, a scratch file written and deleted, a change the agent undid
 *     after a failing test — the transcript still shows the edit, and the
 *     repository is unchanged.
 *
 * The frozen cockpit showed neither: its git pane ran `git status` and its
 * changes pane read the journal, in different tabs, with nothing joining them.
 * So the two questions a reviewer actually asks — "what is in this diff that I
 * was not told about" and "did anything it claimed survive" — had no answer
 * anywhere in the app.
 *
 * This is a PURE FOLD over the two lists, so it is testable without a repository
 * and without a transcript.
 */
import type { GitFileChange, SessionDiff } from "@telar/engine-client";

export type ReviewRow = {
  file: GitFileChange;
  /** The journal claims the session touched this path. */
  reported: boolean;
};

export type SessionReview = {
  rows: ReviewRow[];
  /**
   * Different on disk, absent from the transcript. The rows a reviewer has not
   * seen and would otherwise commit blind.
   */
  unreported: GitFileChange[];
  /**
   * In the transcript, identical on disk. Not a problem — usually a revert — but
   * it is the difference between "the agent did nothing" and "the agent did
   * something and took it back", which are very different reports.
   */
  settled: string[];
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
};

/**
 * A renamed file is reported under BOTH names, because the journal and git
 * disagree about which one it is: a tool that rewrote `a.ts` as `b.ts` journals
 * a write to `b.ts`, while `git diff --find-renames` files the row under the
 * new path and carries the old one alongside. Matching either counts as
 * reported — the alternative is a rename showing up as "never mentioned" on
 * every single review.
 */
function isReported(file: GitFileChange, reported: ReadonlySet<string>): boolean {
  return reported.has(file.path) || (file.renamedFrom !== undefined && reported.has(file.renamedFrom));
}

export function reconcileReview(diff: SessionDiff, reportedPaths: readonly string[]): SessionReview {
  const reported = new Set(reportedPaths);
  const rows = diff.files.map((file) => ({ file, reported: isReported(file, reported) }));
  const onDisk = new Set<string>();
  for (const file of diff.files) {
    onDisk.add(file.path);
    if (file.renamedFrom) onDisk.add(file.renamedFrom);
  }
  return {
    rows,
    unreported: rows.filter((row) => !row.reported).map((row) => row.file),
    settled: reportedPaths.filter((path) => !onDisk.has(path)),
    filesChanged: diff.files.length,
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
  };
}

/** The one-line summary, in the order a reader wants it: how much, then how
 *  much of it is a surprise. Absent counts are omitted rather than printed as
 *  zero — a review with no line counts is a review of binary or untracked
 *  files, not a review of nothing. */
export function describeReview(review: SessionReview): string {
  const parts = [`${review.filesChanged} ${review.filesChanged === 1 ? "file" : "files"}`];
  if (review.linesAdded > 0) parts.push(`+${review.linesAdded}`);
  if (review.linesRemoved > 0) parts.push(`−${review.linesRemoved}`);
  return parts.join(" ");
}

/** The status letter git itself uses, so anyone who has run `git status` reads
 *  this without a legend. `?` for untracked, matching porcelain's `??`. */
export const REVIEW_STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};
