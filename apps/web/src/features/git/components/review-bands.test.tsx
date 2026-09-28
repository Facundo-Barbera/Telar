// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionDiff } from "@telar/engine-client";
import type { SessionReview } from "@/lib/session-review";
import { DiffUnknownBand, ReviewEmptyState } from "./review-bands";

const band = (diff: Partial<SessionDiff>, onRetry?: () => void) =>
  renderToStaticMarkup(<DiffUnknownBand diff={diff as SessionDiff} {...(onRetry ? { onRetry } : {})} />);

const review = (extra: Partial<SessionReview> = {}): SessionReview => ({
  rows: [],
  unreported: [],
  settled: [],
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  ...extra,
});

describe("the band that says git did not answer", () => {
  test("a whole review draws nothing at all, so the ordinary surface stays quiet", () => {
    expect(band({})).toBe("");
  });

  test("a timed-out file list says the list may be short, and offers to ask again", () => {
    const markup = band({ filesIncomplete: "timeout" }, () => {});
    expect(markup).toContain("did not answer in time");
    expect(markup).toContain("may be missing files");
    expect(markup).toContain("Ask git again");
  });

  test("a failure for another reason says what it is instead of promising a retry it cannot keep", () => {
    const markup = band({ filesIncomplete: "failed" }, () => {});
    expect(markup).toContain("could not read");
    expect(markup).not.toContain("did not answer in time");
  });

  test("with no way to ask again, the notice stands alone rather than offering a dead button", () => {
    const markup = band({ filesIncomplete: "timeout" });
    expect(markup).toContain("did not answer in time");
    expect(markup).not.toContain("Ask git again");
  });

  test("the three doubts are three sentences, because they are about different halves of the screen", () => {
    const commits = band({ commitsIncomplete: "timeout" });
    expect(commits).toContain("already committed may not be listed");
    expect(commits).not.toContain("missing files");

    const files = band({ filesIncomplete: "timeout" });
    expect(files).not.toContain("already committed");

    const base = band({ baseUnverified: "timeout" });
    expect(base).toContain("Nothing confirmed the starting point");
    expect(base).not.toContain("missing files");

    const all = band({ filesIncomplete: "timeout", commitsIncomplete: "failed", baseUnverified: "timeout" });
    expect(all).toContain("missing files");
    expect(all).toContain("already committed may not be listed");
    expect(all).toContain("Nothing confirmed the starting point");
  });
});

describe("the empty review", () => {
  test("says nothing differs ONLY when the reads that would contradict it answered", () => {
    expect(renderToStaticMarkup(<ReviewEmptyState review={review()} />)).toContain("Nothing differs from where this session started");
    const unread = renderToStaticMarkup(<ReviewEmptyState review={review()} filesIncomplete="timeout" />);
    expect(unread).not.toContain("Nothing differs");
    expect(unread).toContain("not the same as nothing having changed");
  });

  test("a filter that matches nothing is still about the filter, not about the checkout", () => {
    const markup = renderToStaticMarkup(<ReviewEmptyState review={review({ rows: [{ file: { path: "a.ts", status: "modified" }, reported: true }] })} trimmed="src/" />);
    expect(markup).toContain("Nothing under");
    expect(markup).toContain("src/");
    expect(markup).toContain("differs");
    expect(markup).toContain("The rest of the review has 1 file");
  });

  test("a filter over a cut-short read gives up the same word the unfiltered sentence does", () => {
    const markup = renderToStaticMarkup(<ReviewEmptyState review={review()} trimmed="src/" filesIncomplete="timeout" />);
    expect(markup).toContain("was listed");
    expect(markup).not.toContain("differs");
  });
});
