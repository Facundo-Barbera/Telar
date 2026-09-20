"use client";

/**
 * THE ONE ADAPTER AROUND PIERRE'S VIEWER — and deliberately the only one.
 *
 * TELAR DOES NOT WRITE A DIFF RENDERER (#694). What this replaced was a
 * `<pre>` that split a patch on newlines and coloured a line green if it began
 * with `+` — the third copy of that idea in this app, and the one that had to
 * carry a review of two hundred files. It had no virtualization, no syntax
 * highlighting, no side-by-side, and no way to point at a line. `@pierre/diffs`
 * (Apache-2.0) has all four, and the whole of Telar's renderer is this file
 * plus a block of custom properties in globals.css.
 *
 * THE VIEWER IS A CUSTOM ELEMENT WITH A SHADOW ROOT, which is why the theming
 * is not here. Custom properties inherit straight through a shadow boundary, so
 * `.diff-code-view` in globals.css dresses the whole component from outside it
 * — no !important, nothing injected, and the added-line fill is the same
 * expression `.tint-success` is. See that block for the argument.
 *
 * WHAT THIS FILE OWNS instead is the four decisions that are about THIS app
 * rather than about colour:
 *
 *   1. NO FILE HEADER. Pierre draws a very good one — filename, change icon,
 *      ± counts, collapse. Telar already has that: it is the row you clicked to
 *      get here, and it carries things Pierre cannot know (whether the
 *      transcript mentioned this file, how many times the session rewrote it).
 *      Two headers would be two answers to "which file is this".
 *   2. BOTH THEMES AT ONCE. `github-light`/`github-dark` are the two themes
 *      `lib/highlight.ts` already uses for the file viewer and the transcript's
 *      fenced code, so a snippet quoted in the conversation and the hunk it came
 *      from are coloured identically. Pierre emits `--diffs-token-light` and
 *      `--diffs-token-dark` per token and picks between them in CSS, which is
 *      the same trick `highlight.ts` documents at `defaultColor: false`:
 *      switching Look is a variable flip, with no re-tokenising and no React.
 *   3. THE MAIN THREAD, FOR NOW. Pierre ships a worker pool; the reference adds
 *      one. This does not, yet — a diff is hunks and three lines of context
 *      either side, not a file, and `disableWorkerPool` falls back to Pierre's
 *      own main-thread highlighter. Said out loud because the pool is a real
 *      improvement and the next person should know it was a decision: the Next
 *      form of it (a module re-exporting `@pierre/diffs/worker/worker.js`
 *      through `new URL(…, import.meta.url)`) was verified to build before this
 *      was chosen.
 *   4. A BOUNDED HEIGHT. The viewer virtualizes, which means it needs a
 *      scroll container of its own; it is mounted inside a row inside the
 *      panel's scroller, so it gets a ceiling rather than the page. The same
 *      `max-h-72` the `<pre>` had, for the same reason.
 */

import { PatchDiff } from "@pierre/diffs/react";

import { cn } from "@/lib/utils";

/** How a patch is laid out. Named for the toolbar rather than for the library:
 *  "stacked" is what the control says, `unified` is what Pierre calls it. */
export type DiffLayout = "stacked" | "split";

/**
 * The two themes the rest of the app highlights with. A module constant rather
 * than a prop: a second Diff surface colouring its code differently from the
 * first would be a bug nobody could name.
 */
const THEME = { light: "github-light", dark: "github-dark" } as const;

export function DiffCodeView({
  patch,
  layout,
  wrap,
  className,
}: {
  /** A unified diff, as git printed it. */
  patch: string;
  layout: DiffLayout;
  /**
   * WORD WRAP IS OFF BY DEFAULT and that is the decision, not an oversight
   * (#694). Line lengths in this repository run p50 49, p90 82, p99 136, and
   * the panel at its usual width clears about p55 — so the instinct was to gate
   * side-by-side on width. The reference does not, and is right to: wrapping
   * destroys the column alignment that makes a split diff readable at all, and
   * a long line scrolls. The toggle is a preference, never a threshold.
   */
  wrap: boolean;
  className?: string;
}) {
  return (
    <PatchDiff
      patch={patch}
      // See note 3 above.
      disableWorkerPool
      className={cn("diff-code-view max-h-72", className)}
      options={{
        theme: THEME,
        diffStyle: layout === "split" ? "split" : "unified",
        overflow: wrap ? "wrap" : "scroll",
        // See note 1: the row above is the header.
        disableFileHeader: true,
      }}
    />
  );
}
