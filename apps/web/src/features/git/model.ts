import type { DiffBaseOption, FilePatchOptions, GitFileChange, GitFilePatch, GitPatchIncomplete, SessionDiff } from "@telar/engine-client";
import { unreportedFiles, type SessionReview } from "./session-review";
import type { DiffScopeKind } from "@/lib/diff-scope";
import type { DiffTurn } from "@/lib/diff-turns";
import type { LineSide } from "@/lib/drag-reference";
import type { DiffView } from "./hooks/use-diff-view";
import type { PatchReading } from "./components/diff-code-view";

export type LineRange = { start: number; end: number; startSide: LineSide; endSide: LineSide };

/** `git` answered the working-tree and branch scopes; `journal` is a turn's own reported patch. */
export type PatchWitness = "git" | "journal";

/** A folder or one file, matched at a segment boundary so `apps/we` is not a prefix of `apps/web`. */
export function underDiffFilter(path: string, filter: string): boolean {
  const under = filter.trim().replace(/\/+$/, "");
  if (!under) return true;
  return path === under || path.startsWith(`${under}/`);
}

function fileUnderDiffFilter(file: GitFileChange, filter: string): boolean {
  return underDiffFilter(file.path, filter) || (file.renamedFrom !== undefined && underDiffFilter(file.renamedFrom, filter));
}

/** The review re-folded under one filter, figures re-summed from the rows kept; no filter returns the same object. */
export function reviewUnderFilter(review: SessionReview, filter?: string): SessionReview {
  const under = filter?.trim();
  if (!under) return review;
  const rows = review.rows.filter((row) => fileUnderDiffFilter(row.file, under));
  return {
    rows,
    unreported: unreportedFiles(rows),
    settled: review.settled.filter((path) => underDiffFilter(path, under)),
    filesChanged: rows.length,
    linesAdded: rows.reduce((total, row) => total + (row.file.linesAdded ?? 0), 0),
    linesRemoved: rows.reduce((total, row) => total + (row.file.linesRemoved ?? 0), 0),
  };
}

/** An unanchored turn's review: the journal alone, so every row is reported. */
export function turnReview(turn: DiffTurn | undefined): SessionReview {
  if (!turn) return { rows: [], unreported: [], settled: [], filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
  return {
    rows: turn.files.map((file) => ({ file, reported: true })),
    unreported: [],
    settled: [],
    filesChanged: turn.files.length,
    linesAdded: turn.files.reduce((total, file) => total + (file.linesAdded ?? 0), 0),
    linesRemoved: turn.files.reduce((total, file) => total + (file.linesRemoved ?? 0), 0),
  };
}

/** A turn's reported patch for one path, through the same `incomplete` channel a git read uses. */
export function journalPatch(turn: DiffTurn | undefined, path: string): GitFilePatch {
  const reported = turn?.patches.get(path);
  return reported
    ? { patch: reported.patch, binary: false, ...(reported.truncated ? { incomplete: "truncated" as const } : {}) }
    : { patch: "", binary: false, incomplete: "failed" as const };
}

export function turnNote(turn: DiffTurn, diff: SessionDiff | undefined): string {
  const anchored = Boolean(turn.anchor?.before && turn.anchor.after);
  if (anchored) {
    const committed = turn.anchor?.before !== turn.anchor?.after;
    const range = committed
      ? "What git says changed between where this turn started and where it ended."
      : "This turn committed nothing, so this is what git says changed since it started — including anything written after it ended.";
    return diff?.shared === true
      ? `${range} This checkout is shared with your editor and with every other local session on it, so some of this may not be this turn's.`
      : `${range} This session owns its checkout, so this is as close to one turn's work as git can say.`;
  }
  if (turn.anchor?.read) {
    return "Where the repository stood when this turn ran was never read, so this is the agent's own reported patches rather than git.";
  }
  return "What this turn reported writing — the agent's own patches, not the checkout. Git may disagree, and the working-tree scope is where you would see it.";
}

/** Every option a row's patch read needs; the scope's base goes last so nothing shadows it. */
export function patchRequestFor(file: GitFileChange, view: DiffView, base: DiffBaseOption): FilePatchOptions {
  return {
    ...(file.status === "untracked" ? { untracked: true } : {}),
    ...(view.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    ...(file.renamedFrom ? { renamedFrom: file.renamedFrom } : {}),
    ...base,
  };
}

export const INCOMPLETE_PATCH: Record<GitPatchIncomplete, Record<PatchWitness, string>> = {
  timeout: {
    git: "git did not answer in time — open it again.",
    journal: "This turn's patch for the file did not arrive.",
  },
  failed: {
    git: "git could not read this file's diff.",
    journal: "This turn reported writing this file without a patch for it.",
  },
  truncated: {
    git: "The engine stopped reading this patch at its size limit, so what follows may not be the whole change.",
    journal: "This turn's patch was cut short when it was recorded, so what follows may not be the whole change.",
  },
};

/** A patch with no hunks (a chmod, a pure rename, an all-whitespace change under `-w`) as one sentence. */
export function noHunkSentence(file: NonNullable<PatchReading["file"]>): string {
  const parts: string[] = [];
  if (file.prevName && file.prevName !== file.name) parts.push(`Moved from ${file.prevName}`);
  if (file.mode && file.prevMode && file.mode !== file.prevMode) parts.push(`Mode ${file.prevMode} → ${file.mode}`);
  if (parts.length === 0) return "No lines differ.";
  return `${parts.join(" · ")}. No lines differ.`;
}

export function toggleOpen(current: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(path)) next.add(path);
  return next;
}

export const SCOPE_LABEL: Record<DiffScopeKind, string> = {
  unstaged: "Working tree",
  branch: "Since a base",
  turn: "One turn",
};

export const SCOPE_BLURB: Record<DiffScopeKind, string> = {
  unstaged: "Everything uncommitted in this checkout, right now",
  branch: "Everything since a commit you choose",
  turn: "What one turn reported writing — the agent's own patches",
};
