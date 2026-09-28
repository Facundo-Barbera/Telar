import type { GitFileChange, SessionDiff } from "@telar/engine-client";

export type ReviewRow = {
  file: GitFileChange;
  reported: boolean;
  edits?: number;
  registration?: true;
};

export type SessionReview = {
  rows: ReviewRow[];
  unreported: GitFileChange[];
  settled: string[];
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
};

function journalEdits(file: GitFileChange, reported: ReadonlyMap<string, number>): number | undefined {
  return reported.get(file.path) ?? (file.renamedFrom === undefined ? undefined : reported.get(file.renamedFrom));
}

export function repoRelativePath(path: string, workspacePath: string): string {
  if (!path.startsWith("/")) return path;
  const file = withoutPrivate(path);
  const root = withoutPrivate(workspacePath).replace(/\/+$/, "");
  if (!root) return file;
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

function withoutPrivate(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

function relativeWrites(reported: ReadonlyMap<string, number>, workspacePath: string): Map<string, number> {
  const writes = new Map<string, number>();
  for (const [path, count] of reported) {
    const key = repoRelativePath(path, workspacePath);
    writes.set(key, (writes.get(key) ?? 0) + count);
  }
  return writes;
}

const REGISTRATION_GITIGNORE_RULES = 2;

function isRegistrationGitignore(file: GitFileChange): boolean {
  if (file.path !== ".gitignore" || file.status === "deleted" || file.status === "renamed") return false;
  if ((file.linesRemoved ?? 0) > 0) return false;
  return (file.linesAdded ?? REGISTRATION_GITIGNORE_RULES) <= REGISTRATION_GITIGNORE_RULES;
}

export function unreportedFiles(rows: readonly ReviewRow[]): GitFileChange[] {
  return rows.filter((row) => !row.reported && row.registration === undefined).map((row) => row.file);
}

export function reconcileReview(diff: SessionDiff, reported: ReadonlyMap<string, number>): SessionReview {
  const writes = relativeWrites(reported, diff.workspacePath);
  const rows = diff.files.map((file) => {
    const edits = journalEdits(file, writes);
    const known = edits !== undefined;
    return {
      file,
      reported: known,
      ...(edits !== undefined && edits > 1 ? { edits } : {}),
      ...(!known && isRegistrationGitignore(file) ? { registration: true as const } : {}),
    };
  });
  const onDisk = new Set<string>();
  for (const file of diff.files) {
    onDisk.add(file.path);
    if (file.renamedFrom) onDisk.add(file.renamedFrom);
  }
  return {
    rows,
    unreported: unreportedFiles(rows),
    settled: [...writes.keys()].filter((path) => !onDisk.has(path)),
    filesChanged: diff.files.length,
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
  };
}

export function describeReview(review: SessionReview): string {
  const parts = [`${review.filesChanged} ${review.filesChanged === 1 ? "file" : "files"}`];
  if (review.linesAdded > 0) parts.push(`+${review.linesAdded}`);
  if (review.linesRemoved > 0) parts.push(`−${review.linesRemoved}`);
  return parts.join(" ");
}

export type ReviewFraming = {
  headline: string;
  note: string;
  journal: boolean;
};

export function reviewFraming(diff: SessionDiff, review: SessionReview, session: boolean): ReviewFraming {
  const shared = session && diff.shared === true;
  const figures = describeReview(review);
  return {
    headline: shared ? `The project checkout — ${figures}` : figures,
    note: reviewNote(diff, session, shared),
    journal: session && !shared,
  };
}

function reviewNote(diff: SessionDiff, session: boolean, shared: boolean): string {
  if (!session) return "Everything uncommitted in this project right now.";
  const checkout = "This session shares the project checkout with your editor and every other local session";
  if (!diff.base) {
    return shared
      ? `${checkout}, and no starting commit was recorded — so this counts only what is uncommitted there, not what it wrote.`
      : "No starting commit was recorded, so this counts only what is uncommitted.";
  }
  if (shared) {
    return diff.filesIncomplete
      ? `${checkout}. This is what differs there since it started — as much of it as git reported — which is not the same as what it wrote.`
      : `${checkout}. This is what differs there since it started, which is not the same as what it wrote.`;
  }
  return diff.filesIncomplete
    ? "What this session changed, committed and uncommitted — as much of it as git reported."
    : "Everything this session changed, committed and uncommitted.";
}

export const REVIEW_STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

export const REVIEW_STATUS_WORD: Record<GitFileChange["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};
