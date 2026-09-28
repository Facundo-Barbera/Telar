/**
 * PLACING A DIFF LINE ON THE PULL REQUEST — issue #1014.
 *
 * The Diff surface draws the session's checkout; a review comment anchors to the
 * pull request's head commit and GitHub's own diff. A line chosen here lands on
 * the same line there only when every one of these holds, so each is checked and
 * each has its own sentence:
 *
 *   1. the tab shows the branch scope (committed work against a base), not the
 *      working tree or one turn;
 *   2. the checkout's HEAD is the pull request's head — pushed, and not behind;
 *   3. this file has no uncommitted change on top of that HEAD;
 *   4. the file is in the pull request's diff, with the SAME hunk headers as the
 *      patch drawn here — which is what says the base matches too;
 *   5. the selection sits inside one of those hunks, on its side.
 *
 * A line that passes all five is exactly where GitHub has it, so nothing is
 * mapped or guessed: the numbers the reader selected are the numbers sent.
 */

import type { DiffHunkRange, GitHubLineCommentInput, GitHubLineCommentRefusal, GitHubLineCommentResult, GitHubLineSide, GitHubPullAnchor } from "@telar/engine-client";

import type { DiffScopeKind } from "@/lib/diff-scope";
import type { LineSide } from "@/lib/drag-reference";
import { THREAD_REFUSAL } from "@/lib/github-forge";

export type SelectedLines = { start: number; end: number; startSide: LineSide; endSide: LineSide };
export type PullLineAnchor = Omit<GitHubLineCommentInput, "body">;
export type AnchorAnswer = { anchor: PullLineAnchor } | { reason: string };

export const ANCHOR_REASON = {
  scope: "Switch this tab to the branch scope to comment on the pull request.",
  push: "Push your commits first to comment on the pull request.",
  head: "This checkout isn't at the pull request's latest commit, so its lines can't be placed there.",
  dirty: "This file has uncommitted changes, so its lines can't be placed on the pull request.",
  file: "This file isn't part of the pull request's changes.",
  hunks: "This file's diff here doesn't match the pull request's, so its lines can't be placed there.",
  line: "This line isn't part of the pull request's changes.",
} as const;

/** The hunk headers of a unified diff. A count left out means one line. */
export function hunkRanges(patch: string): DiffHunkRange[] {
  const hunks: DiffHunkRange[] = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

const sameHunks = (left: readonly DiffHunkRange[], right: readonly DiffHunkRange[]) =>
  left.length === right.length &&
  left.every((hunk, index) => {
    const other = right[index]!;
    return hunk.oldStart === other.oldStart && hunk.oldLines === other.oldLines && hunk.newStart === other.newStart && hunk.newLines === other.newLines;
  });

const toSide = (side: LineSide): GitHubLineSide => (side === "before" ? "LEFT" : "RIGHT");

function inHunk(hunk: DiffHunkRange, line: number, side: GitHubLineSide): boolean {
  const [start, count] = side === "LEFT" ? [hunk.oldStart, hunk.oldLines] : [hunk.newStart, hunk.newLines];
  return line >= start && line < start + count;
}

/**
 * Where the selection lands on the pull request, or why it cannot.
 *
 * `undefined` when there is no open pull request at all: then there is nothing
 * to offer, and a sentence about a pull request that does not exist would be noise.
 */
export function anchorPullLines(input: {
  scope: DiffScopeKind;
  anchor: GitHubPullAnchor;
  /** Commits the branch has that its remote does not (`SessionDiff.ahead`). */
  ahead?: number;
  path: string;
  /** The patch drawn for this file on this tab. */
  patch: string;
  range: SelectedLines;
}): AnchorAnswer | undefined {
  const { anchor, path, range } = input;
  const pull = anchor.pull;
  if (!pull) return undefined;
  if (input.scope !== "branch") return { reason: ANCHOR_REASON.scope };
  if (anchor.head !== pull.headRefOid) return { reason: input.ahead ? ANCHOR_REASON.push : ANCHOR_REASON.head };
  if (anchor.dirty.includes(path)) return { reason: ANCHOR_REASON.dirty };
  const file = anchor.files.find((entry) => entry.path === path);
  if (!file || file.hunks.length === 0) return { reason: ANCHOR_REASON.file };
  if (!sameHunks(file.hunks, hunkRanges(input.patch))) return { reason: ANCHOR_REASON.hunks };

  const startSide = toSide(range.startSide);
  const side = toSide(range.endSide);
  let [startLine, line] = [range.start, range.end];
  // A drag upward on one side arrives reversed; GitHub wants the range in order.
  if (startSide === side && startLine > line) [startLine, line] = [line, startLine];
  // GitHub's multi-line comments start and end inside ONE hunk.
  const hunk = file.hunks.find((candidate) => inHunk(candidate, line, side));
  if (!hunk || !inHunk(hunk, startLine, startSide)) return { reason: ANCHOR_REASON.line };

  const base = { commitId: pull.headRefOid, path, line, side };
  if (startLine === line && startSide === side) return { anchor: base };
  return { anchor: { ...base, startLine, startSide } };
}

// ── sending one, optimistically ─────────────────────────────────────────────

/** What a refused comment says: a thread's sentences, reworded for a new one. */
export const LINE_COMMENT_REFUSAL: Record<GitHubLineCommentRefusal, string> = {
  ...THREAD_REFUSAL,
  not_found: "This branch has no open pull request any more. Refresh to see what is there now.",
  invalid_body: "A comment needs something in it, and at most 65,536 characters.",
  stale: "The branch moved after this diff was read. Refresh and select the lines again.",
};

/** A comment under the selection: pending (no url yet) or stored on GitHub. */
export type LineCommentEntry = { body: string; at: number; url?: string };

/**
 * COMMENT, OPTIMISTICALLY. The comment shows at once as pending; GitHub's link
 * then takes its place, or it is removed and the sentence returned — and the
 * caller keeps the draft, so words lost to a missing scope need not be retyped.
 */
export async function applyLineComment(input: {
  current: readonly LineCommentEntry[];
  body: string;
  now: number;
  send: () => Promise<GitHubLineCommentResult>;
  draw: (entries: readonly LineCommentEntry[]) => void;
}): Promise<string | undefined> {
  const { current } = input;
  const body = input.body.trim();
  input.draw([...current, { body, at: input.now }]);
  let result: GitHubLineCommentResult;
  try {
    result = await input.send();
  } catch (cause) {
    input.draw(current);
    return cause instanceof Error && cause.message ? cause.message : "The engine did not answer.";
  }
  if (!result.commented) {
    input.draw(current);
    return result.message && (result.refusal === "failed" || result.refusal === "invalid_body") ? result.message : LINE_COMMENT_REFUSAL[result.refusal];
  }
  input.draw([...current, { body, at: input.now, url: result.url }]);
  return undefined;
}
