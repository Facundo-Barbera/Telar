"use client";

/**
 * THE GIT SURFACE — a review of what this session did to the repository, not a
 * git client.
 *
 * WHAT THE FROZEN COCKPIT HAD HERE, and why almost none of it survived
 * (apps/web_old/components/session/workspace-git-pane.tsx):
 *
 *   - FOUR SUB-PANES behind back arrows — Changes, Branches, Commit, Compare —
 *     inside a rail that already had tabs. Two navigation models fighting each
 *     other. This is one screen.
 *   - A BRANCH LIST WHOSE ROWS RAN `git checkout`, with no confirmation, in the
 *     working tree an agent might be writing to that second. That is a
 *     data-loss button styled as a list item. Gone entirely.
 *   - PER-FILE STAGE/UNSTAGE. Staging is a tool for choosing which of YOUR edits
 *     to record. You did not write these changes; the question is "is this work
 *     good", and the answer is all of it or none. Gone.
 *   - PUSH DISABLED WHILE THE TREE WAS DIRTY — an invented rule (git pushes
 *     commits, not working trees) that read as a broken button. Gone.
 *   - A RAW `<pre>` AT 9px for every diff, in a 320px rail, with no tinting,
 *     while the app's own tinted diff renderer sat one file away. This uses the
 *     shared one.
 *   - AND THE REAL PROBLEM: it answered the wrong question. `git status` forgets
 *     a change the moment the agent commits it, and a branch comparison forgets
 *     everything still uncommitted. Neither is "what has this session done".
 *
 * What replaces it is the fold the frozen app never had: git's diff since the
 * session's own base, JOINED against the journal, so the rows nobody narrated
 * are called out by name. See lib/session-review.ts.
 *
 * ONE MUTATION, deliberately: commit. It is additive, a reset undoes it, and a
 * human pressed it. Anything irreversible belongs in the terminal that is
 * already open two keystrokes away, and this surface says so rather than
 * offering a worse version of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { GitFileChange, SessionDiff, TurnState } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fmtAgo } from "@/lib/format";
import { describeReview, reconcileReview, REVIEW_STATUS_LETTER, type SessionReview } from "@/lib/session-review";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelDivider, PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/**
 * The same fifteen seconds the composer's foot uses, and for the same reason:
 * the working tree changes underneath this process constantly — the agent
 * writing, a human on the same checkout, a build — so a figure has to be recent
 * enough not to be a lie. Fast enough to be current, slow enough to be free.
 */
const REFRESH_MS = 15_000;

const STATUS_TONE: Record<GitFileChange["status"], PanelTone> = {
  added: "done",
  untracked: "attention",
  modified: "none",
  deleted: "danger",
  renamed: "none",
};

/** A unified diff, tinted by line. Third copy of this in the app; the next one
 *  should extract it. */
function Patch({ patch }: { patch: string }) {
  return (
    <pre className="mx-3 mb-2 max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
      {patch.split("\n").map((line, index) => {
        const header = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@") || line.startsWith("diff ");
        return (
          <span
            key={index}
            className={cn(
              "block whitespace-pre-wrap break-words",
              header
                ? "text-muted-foreground/70"
                : line.startsWith("+")
                  ? "bg-success/10 text-success"
                  : line.startsWith("-")
                    ? "bg-destructive/10 text-destructive"
                    : "text-muted-foreground",
            )}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * One changed file. The patch is fetched WHEN OPENED rather than carried on the
 * review, because a two-hundred-file review with every patch is a megabyte on a
 * timer for content nobody asked to see.
 */
function ReviewFileRow({
  sessionId,
  file,
  reported,
}: {
  sessionId: string;
  file: GitFileChange;
  reported: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<string>();
  const [failed, setFailed] = useState(false);
  const cut = file.path.lastIndexOf("/");

  useEffect(() => {
    if (!open || patch !== undefined || failed) return;
    let cancelled = false;
    void api
      .sessionFilePatch(sessionId, file.path, { untracked: file.status === "untracked" })
      .then((result) => {
        if (!cancelled) setPatch(result.file.binary ? "" : result.file.patch);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, patch, failed, sessionId, file.path, file.status]);

  return (
    /* Draggable on the wrapper so the row can be dropped into the message while
       the button inside keeps its press — see the same note on the journal's
       file rows in right-panel.tsx. */
    <div draggable onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(file.path))}>
      <PanelRow tone={STATUS_TONE[file.status]} className="p-0 pl-0">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs hover:bg-muted/60"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          title={file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
        >
          {/* Git's own letter, so anyone who has run `git status` needs no
              legend. */}
          <span className="w-3 shrink-0 font-mono text-[10px] text-muted-foreground">{REVIEW_STATUS_LETTER[file.status]}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {cut > -1 && <span className="text-muted-foreground">{file.path.slice(0, cut + 1)}</span>}
            <span className="text-foreground">{file.path.slice(cut + 1)}</span>
          </span>
          {/* The one badge worth the width: this row is in the diff and was
              never in the transcript. */}
          {!reported && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal text-warning">
              unreported
            </Badge>
          )}
          {file.binary && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal">
              bin
            </Badge>
          )}
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {file.linesAdded ? <span className="text-success">+{file.linesAdded}</span> : null}
            {file.linesAdded && file.linesRemoved ? " " : null}
            {/* U+2212, same width as the plus — the reason the column lines up. */}
            {file.linesRemoved ? <span className="text-destructive">−{file.linesRemoved}</span> : null}
          </span>
        </button>
      </PanelRow>
      {open &&
        (failed ? (
          <p className="px-4 pb-2 text-[11px] text-muted-foreground">git could not produce a patch for this path.</p>
        ) : patch === undefined ? (
          <p className="flex items-center gap-2 px-4 pb-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> reading the diff…
          </p>
        ) : patch === "" ? (
          <p className="px-4 pb-2 text-[11px] text-muted-foreground">Binary file — changed, with no textual diff to show.</p>
        ) : (
          <Patch patch={patch} />
        ))}
      {file.renamedFrom && <p className="px-4 pb-2 pl-[1.9rem] text-[11px] text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

/**
 * THE BAND THAT JUSTIFIES THE WHOLE SURFACE.
 *
 * Rendered only when there is something to say, and stated as a fact rather
 * than an alarm: side effects are normal — installs, builds, formatters — and
 * the point is that you should know they are in the commit before you make it.
 */
function ReconciliationBand({ review }: { review: SessionReview }) {
  if (review.unreported.length === 0 && review.settled.length === 0) return null;
  return (
    <div className="border-b border-border bg-muted/25 px-4 py-2.5 text-[11px] leading-relaxed">
      {review.unreported.length > 0 && (
        <p className="flex gap-1.5 text-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">
              {review.unreported.length} {review.unreported.length === 1 ? "file" : "files"} the transcript never mentioned
            </span>{" "}
            — an install, a build, or a formatter. They are in the diff either way.
          </span>
        </p>
      )}
      {review.settled.length > 0 && (
        <p className={cn("text-muted-foreground", review.unreported.length > 0 && "mt-1.5")}>
          {review.settled.length} {review.settled.length === 1 ? "file the session wrote is" : "files the session wrote are"} back to how
          {review.settled.length === 1 ? " it" : " they"} started.
        </p>
      )}
    </div>
  );
}

function CommitList({ commits }: { commits: SessionDiff["commits"] }) {
  const [open, setOpen] = useState(false);
  if (commits.length === 0) return null;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[11px] hover:bg-muted/40"
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
            <li key={commit.sha} className="flex items-baseline gap-2 px-4 py-1 text-[11px]">
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

/**
 * The commit box.
 *
 * PRE-FILLED FROM THE SESSION TITLE, which is itself derived from the first
 * message — so the default message describes what was asked for, which is the
 * best one-line summary anybody has. Still editable, because it is a commit
 * message.
 *
 * DISABLED WHILE A TURN RUNS. This is the one place a busy guard genuinely
 * matters: `git add -A` in the middle of a write commits half a file, and the
 * half is indistinguishable from the whole afterwards.
 */
function CommitBox({
  sessionId,
  suggestion,
  files,
  busy,
  workspacePath,
  onCommitted,
}: {
  sessionId: string;
  suggestion: string;
  files: number;
  busy: boolean;
  /** Named in full, because the next thing a reader does is `cd` to it. */
  workspacePath: string;
  onCommitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(suggestion);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const commit = async () => {
    setWorking(true);
    setResult(undefined);
    try {
      const answer = await api.commitSessionWork(sessionId, message);
      setResult(
        answer.committed
          ? { ok: true, text: `Committed as ${answer.commit?.shortSha ?? "a new commit"}.` }
          : { ok: false, text: answer.reason ?? "git refused the commit." },
      );
      if (answer.committed) {
        setOpen(false);
        onCommitted();
      }
    } catch (cause) {
      setResult({ ok: false, text: cause instanceof VNextApiError ? cause.message : "The commit could not be sent." });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="border-t border-border p-3">
      {result && (
        <p className={cn("mb-2 rounded-md px-2.5 py-1.5 text-[11px] leading-snug", result.ok ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
          {result.text}
        </p>
      )}
      {open ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            aria-label="Commit message"
            autoFocus
            className="w-full resize-none rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" disabled={working || !message.trim()} onClick={() => void commit()}>
              {working ? <Spinner className="size-3" /> : <GitCommitHorizontalIcon />}
              Commit {files} {files === 1 ? "file" : "files"}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={working} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy || files === 0}
          title={busy ? "A turn is running — the agent may be mid-write" : undefined}
          onClick={() => {
            setMessage(suggestion);
            setOpen(true);
          }}
        >
          <GitCommitHorizontalIcon />
          Commit everything…
        </Button>
      )}
      {/* WHAT THIS SURFACE WILL NOT DO, said once, at the point somebody would
          go looking for it. A cockpit that half-implements staging and branch
          switching is worse than one that names the tool that does them well. */}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Staging, branch switching and discarding are deliberately absent — they are irreversible next to a running agent. This session&rsquo;s
        checkout is <span className="break-all font-mono">{workspacePath}</span>, and a terminal there does all three properly.
      </p>
    </div>
  );
}

export function GitSurface({
  sessionId,
  /** Paths the JOURNAL says this session wrote — `changedFiles(items)`. The other
   *  half of the reconciliation. */
  reportedPaths,
  /** The session title, as the default commit message. */
  suggestion,
  /** A turn is running. Only used to hold the commit button. */
  active,
}: {
  sessionId?: string;
  reportedPaths: readonly string[];
  suggestion: string;
  active?: TurnState;
}) {
  const [diff, setDiff] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      setDiff((await api.sessionDiff(sessionId)).diff);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body, matching the
    // rest of the app: a synchronous fetch-and-setState on mount is a cascading
    // render. `active` is in the deps so a turn SETTLING re-reads — the moment
    // the diff has actually changed is the moment the agent stopped writing.
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load, active]);

  const review = useMemo(() => (diff ? reconcileReview(diff, reportedPaths) : undefined), [diff, reportedPaths]);

  if (!sessionId) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="No session yet">
        The first message creates the session; this shows what it then does to the repository.
      </PanelEmpty>
    );
  }
  if (error) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="Could not read the repository">
        {error}
      </PanelEmpty>
    );
  }
  if (!diff || !review) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
        <Spinner className="size-3" /> reading the repository…
      </p>
    );
  }
  if (!diff.repository) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="Not a git repository">
        This session works in a directory that is not versioned. Sessions run there on purpose — there is simply no diff to review.
      </PanelEmpty>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* THE HEADLINE ANSWERS THE QUESTION IN ONE LINE: how far back the
          comparison reaches, and how big the answer is. */}
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="text-muted-foreground">since</span>
          <span className="font-mono text-foreground">{diff.base ? diff.base.slice(0, 8) : "the last commit"}</span>
          {diff.branch && (
            <>
              <span className="text-border">on</span>
              <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono">{diff.branch}</span>
            </>
          )}
          <button
            type="button"
            aria-label="Refresh the review"
            title="Refresh"
            onClick={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
          </button>
        </div>
        <p className="mt-1 text-sm font-medium tabular-nums">{describeReview(review)}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {/* WITHOUT A BASE THIS IS A SMALLER QUESTION, and saying so is the
              difference between an honest figure and a wrong one: a session
              that committed its work would otherwise review as having done
              nothing at all. */}
          {diff.base
            ? "Everything this session changed, committed and uncommitted."
            : "This session recorded no starting commit, so this is only what is uncommitted right now — anything it committed is not counted."}
          {diff.ahead !== undefined && diff.ahead > 0 ? ` ${diff.ahead} ahead of upstream.` : ""}
          {diff.truncated ? " The list below is capped; the figures above are not." : ""}
        </p>
      </div>

      <ReconciliationBand review={review} />
      <CommitList commits={diff.commits} />

      {review.rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
          Nothing differs from where this session started.
          {review.settled.length > 0 && " Everything it wrote has been put back or committed."}
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Unreported rows lead. They are the ones a reviewer has not seen,
              and burying them in alphabetical order defeats the point. */}
          {review.rows.filter((row) => !row.reported).length > 0 && review.rows.some((row) => row.reported) && (
            <PanelDivider label="not in the transcript" />
          )}
          {review.rows
            .filter((row) => !row.reported)
            .map((row) => (
              <ReviewFileRow key={row.file.path} sessionId={sessionId} file={row.file} reported={false} />
            ))}
          {review.rows.some((row) => row.reported) && review.rows.some((row) => !row.reported) && <PanelDivider label="the session wrote these" />}
          {review.rows
            .filter((row) => row.reported)
            .map((row) => (
              <ReviewFileRow key={row.file.path} sessionId={sessionId} file={row.file} reported />
            ))}
        </div>
      )}

      <div className="mt-auto">
        <CommitBox
          sessionId={sessionId}
          suggestion={suggestion}
          files={review.filesChanged}
          busy={active === "running" || active === "claimed"}
          workspacePath={diff.workspacePath}
          onCommitted={() => void load()}
        />
      </div>
    </div>
  );
}
