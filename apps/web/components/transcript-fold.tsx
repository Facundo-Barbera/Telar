"use client";

/**
 * HOW A RUN OF WORK FOLDS — rules 2 and 3 of the activity lane, in the one place
 * every transcript reads them from.
 *
 * 2. A LIVE RUN SHOWS ONE STEP, behind `+N earlier steps`. An agent running
 *    forty commands must not push the composer off the screen.
 * 3. A SETTLED RUN FOLDS ITS WORK behind `16 steps · Ran command ×12`. History
 *    reads as conclusions.
 *
 * WHY IT IS NOT IN `transcript.tsx`. Those rules belong to the ACTIVITY LANE, not
 * to a session: the Agent's conversation (#569) is a flat row log with no turns,
 * no tasks and no `JournalItem` in it, and its tool calls stacked one flat row
 * each — twelve calls, twelve lines — for exactly as long as the fold lived in a
 * file that could only be handed a session's items. Two copies of "+N earlier
 * steps" is how one gains a failure count and the other does not.
 *
 * SO IT IS GENERIC OVER THE ROW, and knows nothing else about one: whether a row
 * failed and what the tally calls it are questions each transcript answers for
 * its own items, and what a row LOOKS like never reaches here at all —
 * `renderRows` is handed the rows the fold is showing and draws them however
 * that surface draws them.
 *
 * IT OWNS NO CONTAINER. The caller wraps it, because the session's settled fold
 * sits inside a list its group already opened and a live one does not. A
 * component that imposed a `<div>` would make one of the two draw a box it does
 * not want.
 */

import { useState, type ReactNode } from "react";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One row of the activity lane: muted 12px text on transparent, never a card.
 *  Boxing each call turns a forty-step turn into a stack of containers. */
export const ROW =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The failed tally beside a neutral step count.
 *
 * SEPARATELY STYLED, AND ONLY THAT. The count of what went wrong is the
 * destructive part; the count of what happened is not. A collapsed run used to
 * go entirely red on one failure, so "10 steps" where two commands failed read
 * exactly like ten that did (#206). Hidden while the run is open because every
 * failed row is then on screen saying so itself — this is the fold's summary of
 * what it is covering up, not a second error report.
 */
export function FailedCount({ count, hidden }: { count: number; hidden: boolean }) {
  if (hidden || count === 0) return null;
  return (
    <>
      <span className="shrink-0 text-muted-foreground/50">·</span>
      <span className="flex shrink-0 items-center gap-1 text-destructive">
        <TriangleAlertIcon className="size-3 shrink-0" />
        {count} failed
      </span>
    </>
  );
}

export type StepFoldProps<Row> = {
  rows: readonly Row[];
  /** The run is still being appended to: a rolling window rather than a tally. */
  live: boolean;
  /** Whether this row went wrong — asked per row so the fold can count only the
   *  ones it is HIDING. The one on screen reports itself. */
  failed: (row: Row) => boolean;
  /**
   * `Ran command ×12 · Read file ×2`, for the settled summary.
   *
   * A THUNK because a live window never draws one: it says how many steps are
   * behind it and nothing about what they were, so computing the tally for it
   * would be work done for a string nobody reads.
   */
  tally: () => string;
  /** The rows the fold is showing, drawn the way this surface draws them. */
  renderRows: (shown: readonly Row[]) => ReactNode;
};

export function StepFold<Row>({ rows, live, failed, tally, renderRows }: StepFoldProps<Row>) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  if (live) {
    // Only the rows the fold is HIDING can carry a surprise; the one on screen
    // reports itself. Same rule as the settled run, applied to its own window.
    const failures = rows.slice(0, -1).filter(failed).length;
    const hidden = Math.max(0, rows.length - 1);
    return (
      <>
        {hidden > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(ROW, "text-muted-foreground hover:bg-muted/50")}
          >
            <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            <span className="shrink-0">{open ? "Show fewer steps" : `+${hidden} earlier step${hidden === 1 ? "" : "s"}`}</span>
            <FailedCount count={failures} hidden={open} />
          </button>
        )}
        {renderRows(open ? rows : rows.slice(-1))}
      </>
    );
  }

  const failures = rows.filter(failed).length;
  return (
    <>
      {/* THE SUMMARY WRAPS RATHER THAN TRUNCATING (#354). At panel width a busy
          turn ended "· Ran command ×4 · …" with the ellipsis eating the part a
          reader actually scans for — what the agent DID — while the generic head
          of the list survived. Two lines is the whole budget: a fold that grows
          without limit stops being a fold. `items-start` keeps the chevron and
          the step count on the first line rather than centring them against a
          two-line block. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(ROW, "items-start text-muted-foreground hover:bg-muted/50")}
      >
        <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">
          {rows.length} step{rows.length === 1 ? "" : "s"}
        </span>
        <FailedCount count={failures} hidden={open} />
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="line-clamp-2 min-w-0 text-muted-foreground/80">{tally()}</span>
      </button>
      {open && <div className="ml-2 flex flex-col gap-0.5 border-l border-border/70 pl-2">{renderRows(rows)}</div>}
    </>
  );
}
