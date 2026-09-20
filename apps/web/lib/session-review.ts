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
  /**
   * How many times the journal saw this path written, when it saw it at all.
   *
   * THE ONE FACT ONLY THE JOURNAL HAS. Git reports a file's net difference and
   * cannot tell you it was rewritten four times getting there; the row shows the
   * final state either way, so the count is the only honest signal that there
   * were earlier attempts. Absent below 2, because "×1" is every row.
   */
  edits?: number;
  /**
   * Telar's own ignore rules, written when the PROJECT was registered rather
   * than by this session — see `isRegistrationGitignore`. A row nobody in this
   * conversation wrote, and the one thing on the surface that is genuinely not
   * the session's to answer for, so it is labelled instead of counted as a
   * surprise.
   */
  registration?: true;
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
function journalEdits(file: GitFileChange, reported: ReadonlyMap<string, number>): number | undefined {
  return reported.get(file.path) ?? (file.renamedFrom === undefined ? undefined : reported.get(file.renamedFrom));
}

/**
 * THE TWO WITNESSES DO NOT SPELL A PATH THE SAME WAY, and until this they never
 * met (#350).
 *
 * An agent's editor tool journals the file it opened — an ABSOLUTE path,
 * `/private/tmp/exoplanets/paper/main.tex` — while git names everything from
 * the repository root, `paper/main.tex`. Keyed as they arrive, the two sets are
 * disjoint, so every edit the session actually made read "the transcript never
 * mentioned this" and was ALSO counted as "wrote it and put it back": the exact
 * pair of wrong answers a reviewer gets from a join on the wrong key.
 *
 * `/private` IS THE SAME DIRECTORY. macOS resolves `/tmp`, `/var` and `/etc`
 * through `/private`, so one process's realpath and another's literal string
 * name one file two ways, and a prefix match between them fails on four
 * characters. Dropping the prefix from both sides is what a realpath would have
 * achieved, in the one place a browser cannot call one.
 *
 * A path OUTSIDE the checkout is returned unchanged rather than mangled into a
 * pile of `../`: it is not in this diff and never will be, and saying so by
 * simply not matching is the honest answer.
 */
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

/**
 * The journal's map, keyed the way git names things.
 *
 * COUNTS ADD UP ACROSS SPELLINGS. One session can journal the same file both
 * ways — a tool that took an absolute path and one that took a relative one —
 * and those are two writes to one file, not two files written once.
 */
function relativeWrites(reported: ReadonlyMap<string, number>, workspacePath: string): Map<string, number> {
  const writes = new Map<string, number>();
  for (const [path, count] of reported) {
    const key = repoRelativePath(path, workspacePath);
    writes.set(key, (writes.get(key) ?? 0) + count);
  }
  return writes;
}

/**
 * TELAR'S OWN IGNORE RULES, and why they are not the session's fault.
 *
 * Registering a project appends `telar.yaml` and `.telar/` to the repository's
 * root `.gitignore` (`ensureTelarGitignore`, packages/core/src/manifest.ts) —
 * the app writing its own housekeeping into your checkout, before any
 * conversation existed. It then sat in every review as a file "the transcript
 * never mentioned", which is true and useless.
 *
 * MATCHED BY ITS SHAPE, not by its name alone: the root `.gitignore`, growing
 * by no more than the two rules registration writes and losing none. A
 * `.gitignore` anyone actually edited removes a line, adds a third, or — far
 * more decisive — appears in the transcript, and the caller only asks about
 * rows the journal never claimed.
 */
const REGISTRATION_GITIGNORE_RULES = 2;

function isRegistrationGitignore(file: GitFileChange): boolean {
  if (file.path !== ".gitignore" || file.status === "deleted" || file.status === "renamed") return false;
  if ((file.linesRemoved ?? 0) > 0) return false;
  // An untracked file has no counts at all (git does not diff one), and an
  // untracked root `.gitignore` in a project Telar registered is the file
  // registration created.
  return (file.linesAdded ?? REGISTRATION_GITIGNORE_RULES) <= REGISTRATION_GITIGNORE_RULES;
}

/** The rows a reviewer has not seen — which is not every unreported row: see
 *  `ReviewRow.registration`. Shared so a filtered review counts them the same
 *  way the whole one does. */
export function unreportedFiles(rows: readonly ReviewRow[]): GitFileChange[] {
  return rows.filter((row) => !row.reported && row.registration === undefined).map((row) => row.file);
}

/**
 * `reported` IS A MAP, PATH → HOW MANY TIMES THE JOURNAL SAW IT WRITTEN.
 *
 * It was a list of paths, back when the journal had a surface of its own to
 * carry the count. That surface is gone — Changes and Git said the same thing in
 * two tabs, so they are now one Diff — and this fold is the only place left that
 * can join the two witnesses. Taking the count as well as the path costs one
 * field and keeps the last thing the journal knew that git does not.
 *
 * IT IS ALSO THE ONLY PLACE THAT CAN RE-KEY THEM. The journal half is built
 * from items alone (`journalWrites`, components/right-panel.tsx), which have no
 * idea where the checkout is; the diff carries `workspacePath`, so the join is
 * where the two spellings are made one — see `repoRelativePath`.
 */
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

export type ReviewFraming = {
  /** The strong line: the figures, said to be whose they are. */
  headline: string;
  /** The sentence under it — which question these figures answer. */
  note: string;
  /**
   * The journal may be read as DISAGREEING with the diff: an unreported row is
   * a surprise, and the list is worth splitting into claimed and unclaimed.
   * False on a shared checkout and on a canvas, where the diff carries work no
   * transcript could have mentioned.
   */
  journal: boolean;
};

/**
 * WHAT THIS REVIEW IS OF, AND HOW MUCH OF IT THE TRANSCRIPT CAN SPEAK FOR —
 * issue #690.
 *
 * The surface used to say "everything this session changed, committed and
 * uncommitted" over every session's figures. That is true of a `worktree`
 * session, which owns its checkout, and FALSE of a `local` one, which shares
 * the project checkout with the editor and with every other local session: a
 * conversation that wrote no code was shown ninety-two files it had never
 * touched and a banner accusing it of running a formatter.
 *
 * THE FIGURES ARE NOT THE LIE — they describe the checkout correctly. The
 * headline's claim about WHOSE they are, and the journal fold's reading of a
 * row nobody narrated as a surprise, are. On a shared checkout the first is
 * restated and the second is withdrawn: "the transcript never mentioned this"
 * is evidence of nothing when the editor and three other sessions write to the
 * same tree.
 *
 * A PURE FOLD over the diff's own `shared` flag, so both modes are testable
 * without a repository — the surface never re-derives this from a path.
 */
export function reviewFraming(diff: SessionDiff, review: SessionReview, session: boolean): ReviewFraming {
  const shared = session && diff.shared === true;
  const figures = describeReview(review);
  return {
    headline: shared ? `The project checkout — ${figures}` : figures,
    note: reviewNote(diff, session, shared),
    journal: session && !shared,
  };
}

/**
 * TWO INDEPENDENT DOUBTS IN ONE SENTENCE, which is why this is a ladder rather
 * than a nest: WHOSE changes these are (#690) and HOW MUCH of them git managed
 * to report (#654). They compose — a shared checkout read short is both — and
 * the surface must not have to know that.
 *
 * "EVERYTHING" IS A PROMISE A CUT-SHORT READ CANNOT KEEP, so the branches that
 * make it give it up rather than hedging with an adverb. The branches that do
 * not claim everything are left exactly as they were: the band above the
 * figures owns the explanation, and repeating it here would be two warnings for
 * one fact.
 */
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

/** The status letter git itself uses, so anyone who has run `git status` reads
 *  this without a legend. `?` for untracked, matching porcelain's `??`. */
export const REVIEW_STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};
