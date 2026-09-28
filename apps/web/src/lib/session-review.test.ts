/**
 * The reconciliation, which is the whole reason the Diff surface reads the disk
 * rather than the transcript.
 *
 * These are the two facts no other surface in the cockpit can state: what is in
 * the diff that the transcript never mentioned, and what the transcript claimed
 * that the repository does not have.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitFileChange, SessionDiff } from "@telar/engine-client";
import { describeReview, reconcileReview, repoRelativePath, reviewFraming } from "./session-review";

const diff = (
  files: GitFileChange[],
  totals: {
    added?: number;
    removed?: number;
    workspacePath?: string;
    base?: string;
    shared?: boolean;
    filesIncomplete?: SessionDiff["filesIncomplete"];
  } = {},
): SessionDiff => ({
  repository: true,
  workspacePath: totals.workspacePath ?? "/repo",
  files,
  commits: [],
  linesAdded: totals.added ?? 0,
  linesRemoved: totals.removed ?? 0,
  truncated: false,
  ...(totals.base ? { base: totals.base } : {}),
  ...(totals.shared ? { shared: true } : {}),
  ...(totals.filesIncomplete ? { filesIncomplete: totals.filesIncomplete } : {}),
});

const file = (path: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: "modified", ...extra });

/** The journal's half: every path it saw written, once each unless stated. */
const journal = (...paths: (string | [string, number])[]): Map<string, number> =>
  new Map(paths.map((entry) => (typeof entry === "string" ? [entry, 1] : entry)));

describe("reconcileReview", () => {
  test("names the files the session never mentioned", () => {
    // The whole point: `bun.lock` is in the diff and in nobody's transcript, and
    // it is about to be in the commit.
    const review = reconcileReview(
      diff([file("src/auth.ts"), file("bun.lock"), file("dist/app.js", { status: "untracked" })]),
      journal("src/auth.ts"),
    );
    expect(review.unreported.map((entry) => entry.path)).toEqual(["bun.lock", "dist/app.js"]);
    expect(review.rows.map((row) => row.reported)).toEqual([true, false, false]);
  });

  test("names what the transcript claimed and the repository does not have", () => {
    // A file edited and then reverted. Not a problem, and a very different
    // report from "the agent did nothing".
    const review = reconcileReview(diff([file("src/auth.ts")]), journal("src/auth.ts", "src/scratch.ts"));
    expect(review.settled).toEqual(["src/scratch.ts"]);
    expect(review.unreported).toEqual([]);
  });

  test("carries the journal's edit count, and only when it is worth saying", () => {
    // The one fact git cannot supply: a file rewritten four times has the same
    // net diff as a file written once, and the row shows the final state either
    // way. `×1` is every row, so it is not a badge.
    const rows = reconcileReview(diff([file("a.ts"), file("b.ts")]), journal(["a.ts", 4], "b.ts")).rows;
    expect(rows[0]).toMatchObject({ reported: true, edits: 4 });
    expect(rows[1]!.edits).toBeUndefined();
  });

  test("a rename counts as reported under either of its names", () => {
    // The journal records the write under the NEW path; git files the row under
    // the new path and carries the old one. Matching only one would make every
    // rename read as an unreported side effect.
    const renamed = file("src/new.ts", { status: "renamed", renamedFrom: "src/old.ts" });
    expect(reconcileReview(diff([renamed]), journal("src/new.ts")).unreported).toEqual([]);
    expect(reconcileReview(diff([renamed]), journal("src/old.ts")).unreported).toEqual([]);
    // And the old path is not then reported as settled — the file did not vanish.
    expect(reconcileReview(diff([renamed]), journal("src/old.ts")).settled).toEqual([]);
    // The count follows the path it was recorded under.
    expect(reconcileReview(diff([renamed]), journal(["src/old.ts", 3])).rows[0]).toMatchObject({ edits: 3 });
  });

  test("a clean tree with a full transcript is every claim settled, not an empty review", () => {
    // What a session that committed its own work looks like: nothing on disk to
    // review, and the transcript is not evidence of a lie.
    const review = reconcileReview(diff([]), journal("src/a.ts", "src/b.ts"));
    expect(review.filesChanged).toBe(0);
    expect(review.settled).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("no journal at all reports nothing as reported, and nothing as settled", () => {
    // The canvas case: a project's uncommitted work, before any conversation has
    // happened. Every row is genuinely unmentioned, which is why the surface
    // hides the band there rather than badging all of them.
    const review = reconcileReview(diff([file("a.ts")]), journal());
    expect(review.rows[0]).toMatchObject({ reported: false });
    expect(review.settled).toEqual([]);
  });
});

describe("the journal's absolute paths and git's repo-relative ones are the same files (#350)", () => {
  test("an absolute journal path matches the row git filed under its short name", () => {
    // The defect exactly: the agent edited paper/main.tex with its editor tool,
    // which journalled `/tmp/exoplanets/paper/main.tex`, and the row read
    // "unreported" while the same edit was ALSO counted as put back.
    const review = reconcileReview(
      diff([file("paper/main.tex")], { workspacePath: "/tmp/exoplanets" }),
      journal("/tmp/exoplanets/paper/main.tex"),
    );
    expect(review.unreported).toEqual([]);
    expect(review.settled).toEqual([]);
    expect(review.rows[0]).toMatchObject({ reported: true });
  });

  test("/private/tmp and /tmp are one directory, as macOS means them to be", () => {
    // The journal has the realpath and the workspace has the short form, or the
    // other way round. Both are the same four characters apart.
    const workspace = reconcileReview(
      diff([file("paper/main.tex")], { workspacePath: "/tmp/exoplanets" }),
      journal("/private/tmp/exoplanets/paper/main.tex"),
    );
    expect(workspace.unreported).toEqual([]);
    const other = reconcileReview(
      diff([file("paper/main.tex")], { workspacePath: "/private/tmp/exoplanets" }),
      journal("/tmp/exoplanets/paper/main.tex"),
    );
    expect(other.unreported).toEqual([]);
  });

  test("two spellings of one file are one file written twice", () => {
    // A session whose tools disagreed about paths wrote main.tex twice; the
    // count is what the old Changes tab knew and must not be split in half.
    const review = reconcileReview(
      diff([file("paper/main.tex")], { workspacePath: "/tmp/repo" }),
      journal("/tmp/repo/paper/main.tex", "paper/main.tex"),
    );
    expect(review.rows[0]).toMatchObject({ reported: true, edits: 2 });
  });

  test("a settled claim is named the way the reviewer reads every other row", () => {
    // "the session wrote this and put it back" is a repo-relative path in the
    // list beside it, not a machine-local absolute one.
    const review = reconcileReview(diff([], { workspacePath: "/tmp/repo" }), journal("/tmp/repo/src/scratch.ts"));
    expect(review.settled).toEqual(["src/scratch.ts"]);
  });

  test("a file outside the checkout stays as it was written and simply never matches", () => {
    // An agent that edited its own config in $HOME did not edit this repository,
    // and no amount of `../` would make that row appear.
    expect(repoRelativePath("/Users/a/.zshrc", "/tmp/repo")).toBe("/Users/a/.zshrc");
    // A path that merely shares a prefix is not inside it.
    expect(repoRelativePath("/tmp/repo-other/a.ts", "/tmp/repo")).toBe("/tmp/repo-other/a.ts");
    // A trailing slash on the workspace is the same workspace.
    expect(repoRelativePath("/tmp/repo/a.ts", "/tmp/repo/")).toBe("a.ts");
  });
});

describe("Telar's own ignore rules are not the session's doing", () => {
  const gitignore = (extra: Partial<GitFileChange> = {}) => file(".gitignore", { linesAdded: 2, linesRemoved: 0, ...extra });

  test("the two rules registration appends are labelled, not counted as a surprise", () => {
    // `ensureTelarGitignore` adds `telar.yaml` and `.telar/` when the PROJECT is
    // registered. The banner was blaming a conversation that had not started.
    const review = reconcileReview(diff([gitignore(), file("bun.lock")]), journal());
    expect(review.rows[0]).toMatchObject({ reported: false, registration: true });
    expect(review.unreported.map((entry) => entry.path)).toEqual(["bun.lock"]);
  });

  test("a .gitignore that grew past those two rules, or lost one, is an ordinary row", () => {
    expect(reconcileReview(diff([gitignore({ linesAdded: 3 })]), journal()).unreported).toHaveLength(1);
    expect(reconcileReview(diff([gitignore({ linesRemoved: 1 })]), journal()).unreported).toHaveLength(1);
    // Only the repository ROOT's. A nested one is somebody's actual work.
    expect(reconcileReview(diff([file("apps/web/.gitignore", { linesAdded: 2 })]), journal()).unreported).toHaveLength(1);
  });

  test("a .gitignore the session says it wrote is the session's, label or no label", () => {
    const review = reconcileReview(diff([gitignore()]), journal(".gitignore"));
    expect(review.rows[0]).toMatchObject({ reported: true });
    expect(review.rows[0]!.registration).toBeUndefined();
  });

  test("an untracked root .gitignore is the one registration created", () => {
    // git diffs no untracked file, so there are no line counts to match on —
    // and a project with no .gitignore before Telar touched it gets exactly the
    // file `ensureTelarGitignore` writes.
    const review = reconcileReview(diff([file(".gitignore", { status: "untracked" })]), journal());
    expect(review.rows[0]).toMatchObject({ registration: true });
    expect(review.unreported).toEqual([]);
  });
});

/**
 * #690 — the headline stated a falsehood in a `local` session, and the band
 * accused it of running a formatter over files that were dirty before it
 * started. Both modes are asserted here: the fix is only correct if a worktree
 * session's surface is left exactly as it was.
 */
describe("reviewFraming", () => {
  const files = [file("src/auth.ts"), file("bun.lock")];
  const owned = reconcileReview(diff(files, { base: "base000", added: 9, removed: 2 }), journal("src/auth.ts"));
  const sharedReview = reconcileReview(diff(files, { base: "base000", added: 9, removed: 2, shared: true }), journal("src/auth.ts"));

  test("a worktree session still says the work is its own, and still reconciles", () => {
    const framing = reviewFraming(diff(files, { base: "base000", added: 9, removed: 2 }), owned, true);
    expect(framing.headline).toBe("2 files +9 −2");
    expect(framing.note).toBe("Everything this session changed, committed and uncommitted.");
    expect(framing.journal).toBe(true);
  });

  test("a shared checkout names the checkout and does not claim the changes", () => {
    // The observed report: 92 files "everything this session changed" over a
    // conversation that wrote no code. The figures are true; the claim was not.
    const framing = reviewFraming(diff(files, { base: "base000", added: 9, removed: 2, shared: true }), sharedReview, true);
    expect(framing.headline).toBe("The project checkout — 2 files +9 −2");
    expect(framing.note).toContain("shares the project checkout");
    expect(framing.note).not.toContain("Everything this session changed");
  });

  test("a shared checkout withdraws the journal's disagreement, and only that", () => {
    // `bun.lock` is still unreported as a FACT — the fold is unchanged. What
    // goes is the surface's licence to call it a surprise: in a tree the editor
    // and three other sessions write to, silence accuses nobody.
    expect(sharedReview.unreported.map((entry) => entry.path)).toEqual(["bun.lock"]);
    expect(reviewFraming(diff(files, { base: "base000", shared: true }), sharedReview, true).journal).toBe(false);
    // The settled half is the journal's testimony about itself and survives.
    expect(sharedReview.settled).toEqual([]);
  });

  test("a session with no recorded base says so in either mode", () => {
    expect(reviewFraming(diff(files), owned, true).note).toBe("No starting commit was recorded, so this counts only what is uncommitted.");
    const shared = reviewFraming(diff(files, { shared: true }), sharedReview, true).note;
    expect(shared).toContain("no starting commit was recorded");
    expect(shared).toContain("shares the project checkout");
  });

  test("a read git cut short gives up 'everything' in either mode (#654 through the fold)", () => {
    // Two independent doubts that compose: whose changes these are, and how
    // many of them git managed to report. Neither branch may swallow the other.
    expect(reviewFraming(diff(files, { base: "base000", filesIncomplete: "timeout" }), owned, true).note).toBe(
      "What this session changed, committed and uncommitted — as much of it as git reported.",
    );
    const both = reviewFraming(diff(files, { base: "base000", shared: true, filesIncomplete: "failed" }), sharedReview, true).note;
    expect(both).toContain("shares the project checkout");
    expect(both).toContain("as much of it as git reported");
  });

  test("the canvas is untouched — no session to misattribute anything to", () => {
    // A project diff carries no `shared` flag at all, and its copy already
    // named the project rather than a session.
    const framing = reviewFraming(diff(files), reconcileReview(diff(files), journal()), false);
    expect(framing.headline).toBe("2 files");
    expect(framing.note).toBe("Everything uncommitted in this project right now.");
    expect(framing.journal).toBe(false);
  });
});

describe("describeReview", () => {
  test("omits a count of zero rather than printing it", () => {
    // A deletions-only change is not "+0 −40"; a binary-only change has neither
    // figure, and inventing zeros would state a measurement git never made.
    expect(describeReview(reconcileReview(diff([file("a")], { removed: 40 }), journal()))).toBe("1 file −40");
    expect(describeReview(reconcileReview(diff([file("a"), file("b")], { added: 3, removed: 1 }), journal()))).toBe("2 files +3 −1");
    expect(describeReview(reconcileReview(diff([file("a", { binary: true })]), journal()))).toBe("1 file");
  });
});
