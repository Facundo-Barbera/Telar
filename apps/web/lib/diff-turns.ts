/**
 * WHAT ONE TURN REPORTED WRITING — issue #694's third scope.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS THE AGENT'S OWN PATCH, NOT THE DISK, AND THE SURFACE SAYS SO.
 *
 * Every other scope on this surface is git: the working tree, or a range of
 * commits. This one is the JOURNAL — `FileChangeDetail.unifiedDiff`, the patch
 * the agent's own tool produced and reported. The two witnesses disagree
 * constantly and usefully, which is the entire argument of
 * `lib/session-review.ts`: git sees the lockfile `bun install` rewrote and the
 * file a formatter reflowed, and the journal sees an edit that was later
 * reverted and no longer exists anywhere on disk.
 *
 * So a turn scope that rendered this while IMPLYING git would be #690's defect
 * committed a second time — a surface stating as fact something true of one
 * mode and false in another. The surface names the witness where a reader will
 * see it, and this module exists partly so there is one place that says why.
 *
 * WHY NOT ASK GIT. Because a turn has no commit to diff against. Anchoring
 * turns to commits in the engine would make this a git answer and is a much
 * larger change than #694 — recorded in the PR body, not attempted here.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A PURE FOLD over two lists, so it is testable without a repository and
 * without a transcript — the same property `reconcileReview` is built for.
 */

import type { FileChangeKind, GitFileChange, Item, Turn } from "@telar/engine-client";

/** One turn that reported writing at least one file. */
export type DiffTurn = {
  runId: string;
  /** The turn's own number in the session, when the turn record is known. The
   *  count of turns that WROTE something is a different, smaller number, and
   *  labelling with it would quietly renumber the conversation. */
  sequence?: number;
  /** What the human asked for, when known — the only label that tells a reader
   *  which turn this was without counting. */
  input?: string;
  /** When the first reported write landed. Ordering comes from this rather
   *  than from `sequence`, so a session whose turn records did not arrive is
   *  still ordered correctly instead of collapsing into one bucket. */
  at: number;
  /** The rows, in the shape the file list already renders. */
  files: readonly GitFileChange[];
  /**
   * path → the patch that turn's tool reported for it. Absent for a path the
   * tool wrote without producing one, which the row then says.
   *
   * `truncated` RIDES BESIDE THE TEXT rather than inside it (#694, §2.5). The
   * bound used to announce itself as a line in the patch, which the renderer
   * drops as unparseable — so a clipped patch drew as a complete one. It is a
   * fact about the record, so it travels as one.
   */
  patches: ReadonlyMap<string, { patch: string; truncated: boolean }>;
};

/** A path is counted once per turn however many times the turn wrote it: the
 *  row shows the LAST reported patch, which is that turn's net result, and two
 *  rows for one file in one turn would be two answers to one question. */
type Draft = { at: number; order: string[]; byPath: Map<string, { change: GitFileChange; patch?: string; truncated?: boolean }> };

/**
 * The journal's four kinds, in git's vocabulary — so one row component serves
 * both witnesses and the status letters mean the same thing in every scope.
 *
 * `rename` CARRIES ITS OLD NAME rather than being inferred from one: a tool
 * that reports `kind: "rename"` without a `renamedFrom` has told us the change
 * and not the pair, and calling that "modified" is the smaller wrong answer
 * than inventing a previous path. NOTHING MAPS TO `untracked`: that is a
 * statement about git's index, which the journal has never looked at.
 */
function statusOf(kind: FileChangeKind, renamedFrom?: string): GitFileChange["status"] {
  if (kind === "rename" && renamedFrom) return "renamed";
  if (kind === "create") return "added";
  if (kind === "delete") return "deleted";
  return "modified";
}

/**
 * The turns that wrote something, newest first.
 *
 * NEWEST FIRST because the question this scope answers is "what did the agent
 * JUST do" — the default choice is the top of the list, and a reader who wants
 * an older turn is already looking for it.
 *
 * A DECLINED OR FAILED CHANGE NEVER LANDED, so it is not counted — the same
 * refusal `journalWrites` makes, and for the same reason: counting either
 * would claim the turn edited a file it did not.
 */
export function diffTurns(items: readonly Item[], turns: readonly Turn[] = []): DiffTurn[] {
  const drafts = new Map<string, Draft>();
  for (const item of items) {
    if (item.detail.type !== "file_change") continue;
    if (item.status === "declined" || item.status === "failed") continue;
    const change = item.detail.change;
    const draft: Draft = drafts.get(item.runId) ?? { at: item.startedAt, order: [], byPath: new Map() };
    draft.at = Math.min(draft.at, item.startedAt);
    if (!draft.byPath.has(change.path)) draft.order.push(change.path);
    draft.byPath.set(change.path, {
      change: {
        path: change.path,
        status: statusOf(change.kind, change.renamedFrom),
        ...(change.renamedFrom ? { renamedFrom: change.renamedFrom } : {}),
        ...(change.linesAdded === undefined ? {} : { linesAdded: change.linesAdded }),
        ...(change.linesRemoved === undefined ? {} : { linesRemoved: change.linesRemoved }),
      },
      ...(change.unifiedDiff ? { patch: change.unifiedDiff } : {}),
      ...(change.diffTruncated ? { truncated: true } : {}),
    });
    drafts.set(item.runId, draft);
  }

  const byRun = new Map(turns.map((turn) => [turn.runId, turn]));
  const built: DiffTurn[] = [];
  for (const [runId, draft] of drafts) {
    const turn = byRun.get(runId);
    const patches = new Map<string, { patch: string; truncated: boolean }>();
    for (const [path, entry] of draft.byPath) if (entry.patch) patches.set(path, { patch: entry.patch, truncated: entry.truncated === true });
    built.push({
      runId,
      ...(turn ? { sequence: turn.sequence } : {}),
      ...(turn?.input.trim() ? { input: turn.input } : {}),
      at: draft.at,
      // Alphabetical, like every other file list on this surface — the order
      // the tools happened to run in is not an order a reviewer reads in.
      files: draft.order.sort((left, right) => left.localeCompare(right)).map((path) => draft.byPath.get(path)!.change),
      patches,
    });
  }
  return built.sort((left, right) => right.at - left.at);
}

/**
 * The turn a tab is showing: the one it named, or the most recent that wrote
 * anything.
 *
 * FALLING BACK RATHER THAN EMPTYING. A named turn can genuinely disappear —
 * the transcript window slid past it, the turn was discarded — and showing
 * nothing with no explanation is the worse of the two answers. The caller can
 * tell the two apart by comparing `runId` with what it asked for.
 */
export function turnFor(turns: readonly DiffTurn[], runId: string | undefined): DiffTurn | undefined {
  return (runId ? turns.find((turn) => turn.runId === runId) : undefined) ?? turns[0];
}

/** A turn's one-line label. The prompt when there is one, cut at its first
 *  line — a turn's input is often a page, and a picker row is not. */
export function turnLabel(turn: DiffTurn): string {
  const first = turn.input?.split("\n").find((line) => line.trim())?.trim();
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return turn.sequence === undefined ? "A turn" : `Turn ${turn.sequence}`;
}
