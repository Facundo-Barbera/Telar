// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { GitFileChange, SessionDiff } from "@telar/engine-client";
import { reconcileReview } from "@/lib/session-review";
import { reviewUnderFilter, underDiffFilter } from "./model";
import { describePanelTabInstance, type PanelTabItem } from "@/features/panel";

const file = (path: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({
  path,
  status: "modified",
  linesAdded: 10,
  linesRemoved: 1,
  ...extra,
});

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
  file("apps/web/src/components/session/diff-surface.tsx"),
  file("apps/web/src/lib/right-panel-tabs.ts"),
  file("apps/engine/src/git.ts"),
  file("docs/review.md"),
  file("docs-old/review.md"),
];

const review = reconcileReview(diff(FILES), new Map([["apps/engine/src/git.ts", 2]]));
const paths = (rows: { file: GitFileChange }[]) => rows.map((row) => row.file.path);

const tab = (id: string, filter?: string): PanelTabItem => ({ id, kind: "diff", ...(filter ? { params: { filter } } : { params: {} }) });

describe("two Diff instances, one review", () => {
  test("each shows only what is under its own filter", () => {
    const web = tab("diff", "apps/web");
    const engine = tab("diff#2", "apps/engine");
    expect(paths(reviewUnderFilter(review, web.params.filter).rows)).toEqual([
      "apps/web/src/components/session/diff-surface.tsx",
      "apps/web/src/lib/right-panel-tabs.ts",
    ]);
    expect(paths(reviewUnderFilter(review, engine.params.filter).rows)).toEqual(["apps/engine/src/git.ts"]);
  });

  test("…and each wears its own label, while an unfiltered one reads Diff", () => {
    const described = (instance: PanelTabItem) => describePanelTabInstance(instance, { duplicate: true }).label;
    expect(described(tab("diff", "apps/web"))).toBe("Diff · apps/web");
    expect(described(tab("diff#2", "apps/engine"))).toBe("Diff · apps/engine");
    expect(described(tab("diff#3"))).toBe("Diff");
  });

  test("a filter on ONE tab is a label on that tab only — a lone Diff is still Diff", () => {
    expect(describePanelTabInstance(tab("diff", "apps/web")).label).toBe("Diff");
  });

  test("no filter shows everything, as the same object", () => {
    const all = reviewUnderFilter(review, undefined);
    expect(paths(all.rows)).toEqual(FILES.map((entry) => entry.path));
    expect(all).toBe(review);
    expect(reviewUnderFilter(review, "   ")).toBe(review);
  });
});

describe("what a filter matches", () => {
  test("a folder keeps everything under it; one file keeps itself", () => {
    expect(underDiffFilter("apps/web/src/lib/utils.ts", "apps/web")).toBe(true);
    expect(underDiffFilter("apps/web/src/lib/utils.ts", "apps/web/src/lib/utils.ts")).toBe(true);
    expect(underDiffFilter("apps/web/src/lib/utils.ts", "apps/engine")).toBe(false);
  });

  test("it matches at a SEGMENT boundary, so a neighbour is not dragged in", () => {
    expect(paths(reviewUnderFilter(review, "docs").rows)).toEqual(["docs/review.md"]);
    expect(underDiffFilter("docs-old/review.md", "docs")).toBe(false);
    expect(underDiffFilter("apps/web/src/lib/utils.ts", "apps/we")).toBe(false);
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
    expect(review.filesChanged).toBe(5);
    expect(review.linesAdded).toBe(50);
  });

  test("the reconciliation is re-derived, so the band describes this tab's rows", () => {
    expect(reviewUnderFilter(review, "apps/web").unreported.map((entry) => entry.path)).toEqual([
      "apps/web/src/components/session/diff-surface.tsx",
      "apps/web/src/lib/right-panel-tabs.ts",
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
    expect(review.rows).toHaveLength(5);
  });
});
