/**
 * WHAT THE DIFF SURFACE SAYS WHEN GIT DID NOT ANSWER — issue #654.
 *
 * THE ENGINE FIX ALONE DOES NOT FIX THIS BUG, which is the lesson #650 paid for
 * once already: `filesIncomplete` reaching the client is worth nothing while
 * this surface draws a review that timed out exactly as it draws a session that
 * changed nothing. So the two are pinned as DIFFERENT MARKUP here, on the
 * sentences a person actually reads.
 *
 * `DiffUnknownBand` and `ReviewEmptyState`, not `DiffSurface`: the review
 * arrives over a poll, and a static render never runs the effect that starts
 * one. These are the halves that decide what a reader sees, so they are the
 * halves handed the answer — the same split `workspace-environment.test.tsx`
 * makes for the base picker.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionDiff } from "@telar/engine-client";
import type { SessionReview } from "@/lib/session-review";
import { DiffUnknownBand, ReviewEmptyState } from "./diff-surface";

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
    // The offer that matches the failure: a timeout is the one that clears on
    // its own, because the machine was busy.
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
    /**
     * THE WHOLE REASON THE ENGINE CARRIES THREE FLAGS. A `git log` that was
     * killed says nothing whatever about the file list under it, and a reader
     * told to distrust everything distrusts the wrong thing — or nothing.
     */
    const commits = band({ commitsIncomplete: "timeout" });
    expect(commits).toContain("already committed may not be listed");
    expect(commits).not.toContain("missing files");

    const files = band({ filesIncomplete: "timeout" });
    expect(files).not.toContain("already committed");

    const base = band({ baseUnverified: "timeout" });
    expect(base).toContain("Nothing confirmed the starting point");
    expect(base).not.toContain("missing files");

    // All three at once, all three said.
    const all = band({ filesIncomplete: "timeout", commitsIncomplete: "failed", baseUnverified: "timeout" });
    expect(all).toContain("missing files");
    expect(all).toContain("already committed may not be listed");
    expect(all).toContain("Nothing confirmed the starting point");
  });
});

describe("the empty review", () => {
  test("says nothing differs ONLY when the reads that would contradict it answered", () => {
    // The claim a person acts on: an empty Diff panel is how you decide a
    // session did no work and archive it.
    expect(renderToStaticMarkup(<ReviewEmptyState review={review()} />)).toContain("Nothing differs from where this session started");
    const unread = renderToStaticMarkup(<ReviewEmptyState review={review()} filesIncomplete="timeout" />);
    expect(unread).not.toContain("Nothing differs");
    expect(unread).toContain("not the same as nothing having changed");
  });

  test("a filter that matches nothing is still about the filter, not about the checkout", () => {
    // Unchanged by #654, and pinned so it stays that way: "nothing differs" over
    // a tree with forty changed files sends somebody hunting a bug in git.
    const markup = renderToStaticMarkup(<ReviewEmptyState review={review({ rows: [{ file: { path: "a.ts", status: "modified" }, reported: true }] })} trimmed="src/" />);
    expect(markup).toContain("Nothing under");
    expect(markup).toContain("src/");
    expect(markup).toContain("differs");
    expect(markup).toContain("The rest of the review has 1 file");
  });

  test("a filter over a cut-short read gives up the same word the unfiltered sentence does", () => {
    // "differs" is a claim about the checkout whichever scope it is narrowed to.
    const markup = renderToStaticMarkup(<ReviewEmptyState review={review()} trimmed="src/" filesIncomplete="timeout" />);
    expect(markup).toContain("was listed");
    expect(markup).not.toContain("differs");
  });
});
