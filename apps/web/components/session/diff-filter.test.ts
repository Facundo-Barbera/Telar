/**
 * TWO DIFF TABS THAT DISAGREE (#335) — the whole acceptance of the issue, as a
 * fold rather than as a screen.
 *
 * The filter is a string in the tab's params, and everything that makes it
 * visible is pure: `reviewUnderFilter` decides which rows the surface draws and
 * what its headline counts, `panelTabSuffix` decides what the strip calls it.
 * So "two Diff tabs show different file lists and different labels, and one
 * with no filter shows everything" is decidable here, without the DOM harness
 * this app does not have — the same instrument `lib/session-review.test.ts`
 * uses on the fold underneath it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitFileChange, SessionDiff } from "@telar/engine-client";
import { reconcileReview } from "@/lib/session-review";
import { reviewUnderFilter, underDiffFilter } from "./diff-surface";
import { describePanelTabInstance, type PanelTabItem } from "@/components/right-panel";

const file = (path: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({
  path,
  status: "modified",
  linesAdded: 10,
  linesRemoved: 1,
  ...extra,
});

/** A change that straddles two apps and a doc — the review a filter is for. */
const diff = (files: GitFileChange[]): SessionDiff =>
  ({
    repository: true,
    workspacePath: "/w",
    files,
    commits: [],
    linesAdded: files.reduce((total, entry) => total + (entry.linesAdded ?? 0), 0),
    linesRemoved: files.reduce((total, entry) => total + (entry.linesRemoved ?? 0), 0),
  }) as unknown as SessionDiff;

const FILES = [
  file("apps/web/components/session/diff-surface.tsx"),
  file("apps/web/lib/right-panel-tabs.ts"),
  file("apps/engine/src/git.ts"),
  file("docs/review.md"),
  file("docs-old/review.md"),
];

const review = reconcileReview(diff(FILES), new Map([["apps/engine/src/git.ts", 2]]));
const paths = (rows: { file: GitFileChange }[]) => rows.map((row) => row.file.path);

/** A tab as the strip holds it, which is the only place the filter lives. */
const tab = (id: string, filter?: string): PanelTabItem => ({ id, kind: "diff", ...(filter ? { params: { filter } } : { params: {} }) });

describe("two Diff instances, one review", () => {
  test("each shows only what is under its own filter", () => {
    const web = tab("diff", "apps/web");
    const engine = tab("diff#2", "apps/engine");
    expect(paths(reviewUnderFilter(review, web.params.filter).rows)).toEqual([
      "apps/web/components/session/diff-surface.tsx",
      "apps/web/lib/right-panel-tabs.ts",
    ]);
    expect(paths(reviewUnderFilter(review, engine.params.filter).rows)).toEqual(["apps/engine/src/git.ts"]);
  });

  test("…and each wears its own label, while an unfiltered one reads Diff", () => {
    const described = (instance: PanelTabItem) => describePanelTabInstance(instance, { duplicate: true }).label;
    expect(described(tab("diff", "apps/web"))).toBe("Diff · apps/web");
    expect(described(tab("diff#2", "apps/engine"))).toBe("Diff · apps/engine");
    // Nothing to say is not a failure: no dangling separator.
    expect(described(tab("diff#3"))).toBe("Diff");
  });

  test("a filter on ONE tab is a label on that tab only — a lone Diff is still Diff", () => {
    // The suffix appears on both or neither, which is #322's rule and not
    // something a filter changes.
    expect(describePanelTabInstance(tab("diff", "apps/web")).label).toBe("Diff");
  });

  test("no filter shows everything, as the same object", () => {
    const all = reviewUnderFilter(review, undefined);
    expect(paths(all.rows)).toEqual(FILES.map((entry) => entry.path));
    // Identity, not just equality: an unfiltered Diff is the surface it was
    // before filters existed.
    expect(all).toBe(review);
    expect(reviewUnderFilter(review, "   ")).toBe(review);
  });
});

describe("what a filter matches", () => {
  test("a folder keeps everything under it; one file keeps itself", () => {
    expect(underDiffFilter("apps/web/lib/utils.ts", "apps/web")).toBe(true);
    expect(underDiffFilter("apps/web/lib/utils.ts", "apps/web/lib/utils.ts")).toBe(true);
    expect(underDiffFilter("apps/web/lib/utils.ts", "apps/engine")).toBe(false);
  });

  test("it matches at a SEGMENT boundary, so a neighbour is not dragged in", () => {
    expect(paths(reviewUnderFilter(review, "docs").rows)).toEqual(["docs/review.md"]);
    expect(underDiffFilter("docs-old/review.md", "docs")).toBe(false);
    // A half-typed folder matches nothing rather than something arbitrary.
    expect(underDiffFilter("apps/web/lib/utils.ts", "apps/we")).toBe(false);
  });

  test("a trailing slash and surrounding space are the same filter", () => {
    expect(paths(reviewUnderFilter(review, "docs/").rows)).toEqual(["docs/review.md"]);
    expect(paths(reviewUnderFilter(review, " docs ").rows)).toEqual(["docs/review.md"]);
  });

  test("a renamed file is under EITHER of its names", () => {
    const renamed = reconcileReview(diff([file("apps/web/b.ts", { status: "renamed", renamedFrom: "apps/engine/a.ts" })]), new Map());
    expect(paths(reviewUnderFilter(renamed, "apps/web").rows)).toEqual(["apps/web/b.ts"]);
    expect(paths(reviewUnderFilter(renamed, "apps/engine").rows)).toEqual(["apps/web/b.ts"]);
  });
});

describe("the figures follow the list", () => {
  test("the headline counts what is on screen, re-summed from the rows that survived", () => {
    const web = reviewUnderFilter(review, "apps/web");
    expect(web.filesChanged).toBe(2);
    expect(web.linesAdded).toBe(20);
    expect(web.linesRemoved).toBe(2);
    // The unfiltered review still reports the repository's own totals.
    expect(review.filesChanged).toBe(5);
    expect(review.linesAdded).toBe(50);
  });

  test("the reconciliation is re-derived, so the band describes this tab's rows", () => {
    // `apps/engine/src/git.ts` is the only reported file; under `apps/web`
    // every row is unreported, and under `apps/engine` none is.
    expect(reviewUnderFilter(review, "apps/web").unreported.map((entry) => entry.path)).toEqual([
      "apps/web/components/session/diff-surface.tsx",
      "apps/web/lib/right-panel-tabs.ts",
    ]);
    expect(reviewUnderFilter(review, "apps/engine").unreported).toEqual([]);
  });

  test("a file the journal wrote and the tree no longer differs on is settled under its own folder only", () => {
    const settled = reconcileReview(diff(FILES), new Map([["apps/web/gone.ts", 1]]));
    expect(settled.settled).toEqual(["apps/web/gone.ts"]);
    expect(reviewUnderFilter(settled, "apps/web").settled).toEqual(["apps/web/gone.ts"]);
    expect(reviewUnderFilter(settled, "apps/engine").settled).toEqual([]);
  });

  test("a filter that matches nothing is an empty list, not an empty review", () => {
    const none = reviewUnderFilter(review, "workers");
    expect(none.rows).toEqual([]);
    expect(none.filesChanged).toBe(0);
    // …which is why the surface has the whole review to say so with.
    expect(review.rows).toHaveLength(5);
  });
});
