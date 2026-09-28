"use client";

import { useState } from "react";
import { GitCommitHorizontalIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { SessionDiff } from "@telar/engine-client";
import type { SessionReview } from "../session-review";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** What git did not answer, above the rows rather than in place of them: the rows that arrived are still real. */
export function DiffUnknownBand({
  diff,
  onRetry,
}: {
  diff: Pick<SessionDiff, "filesIncomplete" | "commitsIncomplete" | "baseUnverified">;
  onRetry?: () => void | Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const sentences: string[] = [];
  if (diff.filesIncomplete) {
    sentences.push(
      diff.filesIncomplete === "timeout"
        ? "git did not answer in time, so this list may be missing files and the counts may be low — it is not the whole change."
        : "git could not read this checkout's changes, so this list may be missing files and the counts may be low.",
    );
  }
  if (diff.commitsIncomplete) {
    sentences.push(
      diff.commitsIncomplete === "timeout"
        ? "git did not answer in time for this session's commits, so work it has already committed may not be listed."
        : "git could not read this session's commits, so work it has already committed may not be listed.",
    );
  }
  if (diff.baseUnverified) {
    sentences.push("Nothing confirmed the starting point below — it is the one recorded when this checkout was cut.");
  }
  if (sentences.length === 0) return null;
  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="border-b border-warning/30 tint-warning px-4 py-2.5">
      {sentences.map((sentence) => (
        <p key={sentence} className="flex gap-1.5 text-2xs leading-relaxed text-warning">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{sentence}</span>
        </p>
      ))}
      {onRetry && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          className="mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-2xs font-medium text-warning transition-colors outline-none hover:bg-warning/15 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <RefreshCwIcon className={cn("size-3 shrink-0", retrying && "animate-spin")} />
          {retrying ? "Asking git again…" : "Ask git again"}
        </button>
      )}
    </div>
  );
}

/** "Nothing differs" is only said when the reads that could contradict it answered, and never about a filter. */
export function ReviewEmptyState({
  review,
  trimmed,
  filesIncomplete,
}: {
  review: SessionReview;
  trimmed?: string;
  filesIncomplete?: SessionDiff["filesIncomplete"];
}) {
  return (
    <div className="px-4 py-6 text-center text-2xs text-muted-foreground">
      {trimmed ? (
        <>
          Nothing under <span className="font-mono">{trimmed}</span> {filesIncomplete ? "was listed" : "differs"}.
          {review.rows.length > 0 && ` The rest of the review has ${review.rows.length} ${review.rows.length === 1 ? "file" : "files"}.`}
        </>
      ) : filesIncomplete ? (
        <>Nothing was listed — and with git not answering in full, that is not the same as nothing having changed.</>
      ) : (
        <>
          Nothing differs from where this session started.
          {review.settled.length > 0 && " Everything it wrote has been put back or committed."}
        </>
      )}
    </div>
  );
}

export function TurnEmptyState({ noTurns, trimmed }: { noTurns: boolean; trimmed: string | undefined }) {
  return (
    <div className="px-4 py-6 text-center text-2xs text-muted-foreground">
      {noTurns
        ? "No turn in this conversation has reported writing a file yet."
        : trimmed
          ? `This turn reported nothing under ${trimmed}.`
          : "This turn reported writing nothing."}
    </div>
  );
}

/** Unreported files are only named when the transcript speaks for the tree (`journal`); settled ones always. */
export function ReconciliationBand({ review, journal }: { review: SessionReview; journal: boolean }) {
  const unreported = journal ? review.unreported : [];
  if (unreported.length === 0 && review.settled.length === 0) return null;
  return (
    <div className="border-b border-border bg-muted/25 px-4 py-2.5 text-2xs leading-relaxed">
      {unreported.length > 0 && (
        <p className="flex gap-1.5 text-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">
              {unreported.length} {unreported.length === 1 ? "file" : "files"} the transcript never mentioned
            </span>{" "}
            — an install, a build, or a formatter.
          </span>
        </p>
      )}
      {review.settled.length > 0 && (
        <p className={cn("text-muted-foreground", unreported.length > 0 && "mt-1.5")}>
          {review.settled.length} {review.settled.length === 1 ? "file the session wrote is" : "files the session wrote are"} back to how
          {review.settled.length === 1 ? " it" : " they"} started.
        </p>
      )}
    </div>
  );
}

export function CommitList({ commits }: { commits: SessionDiff["commits"] }) {
  const [open, setOpen] = useState(false);
  if (commits.length === 0) return null;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-2xs hover:bg-muted/40"
      >
        <GitCommitHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {commits.length} {commits.length === 1 ? "commit" : "commits"} since it started
        </span>
        <span className="ml-auto font-mono text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul className="pb-1">
          {commits.map((commit) => (
            <li key={commit.sha} className="flex items-baseline gap-2 px-4 py-1 text-2xs">
              <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
              <span className="min-w-0 flex-1 truncate" title={commit.subject}>
                {commit.subject || "(no subject)"}
              </span>
              <span className="shrink-0 text-muted-foreground">{fmtAgo(commit.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
