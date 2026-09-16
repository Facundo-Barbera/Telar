"use client";

/**
 * THE DIFF SURFACE — a review of what this session did to the repository, not a
 * git client.
 *
 * IT USED TO BE TWO TABS, and that was the mistake. "Changes" folded the journal
 * — every path the agent said it wrote, with the patch its own tool produced —
 * and "Git" read the disk. Both drew a list of files with `+`/`−` counts and an
 * expandable diff, side by side in the same strip, and the honest answer to "what
 * is the difference" took a paragraph. So there is one tab, and it is called what
 * a person came looking for.
 *
 * THE DISK IS THE WITNESS, THE JOURNAL IS THE ANNOTATION. Git is the one that can
 * be checked: it sees the lockfile `bun install` rewrote, the snapshot a test
 * dropped, the file a formatter reflowed — none of which any transcript mentions,
 * all of which are about to be in the commit. The journal supplies what git
 * cannot: which of these rows the conversation actually claimed (the dividers
 * below), which claims left no trace (`settled`), and how many times a path was
 * rewritten on the way to its current state (`×N`). Nothing the Changes tab
 * showed was dropped except the agent's own copy of the patch, which is the one
 * thing on that surface that could disagree with the file on disk.
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
 *
 * AND IT IS A SURFACE YOU CAN HAVE TWO OF (#335). A review of a big change is
 * one list of forty files, and comparing what happened in `apps/web` against
 * what happened in `apps/engine` meant scrolling between them. Each Diff tab
 * carries a FILTER — a folder or one file, held in the tab's own params, so the
 * strip can name it ("Diff · apps/web/") and the panel persists it with the
 * rest of the arrangement. One Diff with no filter is the surface this file
 * described before: the filter is an instance's identity, not a mode.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitBranchIcon,
  HardDriveIcon,
  GitCommitHorizontalIcon,
  ListFilterIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { GitFileChange, SessionDiff, TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import { describeReview, reconcileReview, REVIEW_STATUS_LETTER, unreportedFiles, type SessionReview } from "@/lib/session-review";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PanelDivider, PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();

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

/**
 * WHAT A FILTER MEANS: a folder or one file, and nothing cleverer (#335).
 *
 * `apps/web` keeps everything under it; `apps/web/lib/utils.ts` keeps that one
 * file. MATCHED AT A SEGMENT BOUNDARY, so `apps/we` is not a prefix of
 * `apps/web` — a field you type into character by character would otherwise
 * spend every intermediate keystroke showing a different, accidental review,
 * and `docs` would quietly drag in `docs-old`. A trailing slash is the same
 * filter as none: `src/` and `src` are one folder to anybody who has typed a
 * path, and the tab label reads the same either way.
 *
 * NOT A SEARCH. A basename (`utils.ts`) matches nothing, deliberately: this is
 * the instance's identity — the thing the tab is named after and the thing it
 * is persisted with — and a fuzzy rule would make two tabs whose labels agree
 * show two different lists.
 */
export function underDiffFilter(path: string, filter: string): boolean {
  const under = filter.trim().replace(/\/+$/, "");
  if (!under) return true;
  return path === under || path.startsWith(`${under}/`);
}

/** A rename is under the filter by EITHER name — the row is one change, and it
 *  belongs to both folders it straddles. Same reasoning as `journalEdits` in
 *  lib/session-review.ts, which reconciles the two names for the same reason. */
function fileUnderDiffFilter(file: GitFileChange, filter: string): boolean {
  return underDiffFilter(file.path, filter) || (file.renamedFrom !== undefined && underDiffFilter(file.renamedFrom, filter));
}

/**
 * THE REVIEW UNDER ONE FILTER — the whole of what makes two Diff tabs different.
 *
 * A FOLD RATHER THAN A HIDDEN ROW, because every figure on this surface is a
 * count of the rows beneath it: filtering the list and leaving `48 files +900
 * −120` above four rows would be a headline about a review nobody is looking
 * at. The line counts are re-summed from the rows that survived, which is the
 * one case where `diff.linesAdded` stops being the answer — it is the
 * repository's total, and stays the honest total when the list is capped.
 *
 * NO FILTER RETURNS THE SAME OBJECT, so an unfiltered Diff is byte for byte the
 * surface it was before this existed.
 */
export function reviewUnderFilter(review: SessionReview, filter?: string): SessionReview {
  const under = filter?.trim();
  if (!under) return review;
  const rows = review.rows.filter((row) => fileUnderDiffFilter(row.file, under));
  return {
    rows,
    unreported: unreportedFiles(rows),
    settled: review.settled.filter((path) => underDiffFilter(path, under)),
    filesChanged: rows.length,
    linesAdded: rows.reduce((total, row) => total + (row.file.linesAdded ?? 0), 0),
    linesRemoved: rows.reduce((total, row) => total + (row.file.linesRemoved ?? 0), 0),
  };
}

/** A unified diff, tinted by line. Third copy of this in the app; the next one
 *  should extract it. */
function Patch({ patch }: { patch: string }) {
  return (
    <pre className="mx-3 mb-2 max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-3xs leading-relaxed">
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
  readPatch,
  file,
  reported,
  edits,
  registration,
  onOpenFile,
  onOpenInNewPanelTab,
  onInsertReference,
}: {
  /** Session-scoped or project-scoped — the row does not care which, which is
   *  what lets one surface serve a conversation and a canvas. */
  readPatch: (path: string, untracked: boolean) => Promise<{ file: { patch: string; binary: boolean } }>;
  file: GitFileChange;
  reported: boolean;
  /** How many times the journal saw this path written, when that is more than
   *  once — the one thing the old Changes tab knew that git does not. */
  edits?: number;
  /** Telar's own ignore rules, added when the project was registered. Says so
   *  in place of "unreported", which was true and blamed the wrong party. */
  registration?: true;
  /** Open this path in the Editor. Threaded exactly the way LatexSurface's is
   *  — the panel derives it from its own `onOpenTab`, so there is no second
   *  route into the Editor. */
  onOpenFile?: (path: string) => void;
  /**
   * Review this row's path in a DIFF TAB OF ITS OWN (#335) — the same verb the
   * file tree and the transcript already offer, pointed at this surface rather
   * than the Editor: the new tab is a second Diff whose filter is this path, so
   * one part of a change can be read beside another. Absent hides the item.
   */
  onOpenInNewPanelTab?: (path: string) => void;
  /** Put the row's reference into the message being written — the same string
   *  and the same `fileReference` the row's own DRAG already carries. */
  onInsertReference?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<string>();
  const [failed, setFailed] = useState(false);
  const cut = file.path.lastIndexOf("/");

  useEffect(() => {
    if (!open || patch !== undefined || failed) return;
    let cancelled = false;
    void readPatch(file.path, file.status === "untracked")
      .then((result) => {
        if (!cancelled) setPatch(result.file.binary ? "" : result.file.patch);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, patch, failed, readPatch, file.path, file.status]);

  return (
    /* Draggable on the wrapper so the row can be dropped into the message while
       the button inside keeps its press — see the same note on the journal's
       file rows in right-panel.tsx. */
    <div draggable onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(file.path))}>
      {/* THE TRIGGER IS INSIDE THE DRAGGABLE, wrapping only the row's own
          content — the app's trigger-inside rule, and for its
          reason: a right-click on the drag handle would race the drag.

          STAGE, UNSTAGE AND REVERT ARE NOT HERE, and their absence is the same
          decision this file's header already argues at length (`apps/engine/
          src/git.ts` refuses them by construction). A menu is exactly where
          they would sneak back in as "just three more rows". */}
      <ContextMenu>
        <ContextMenuTrigger>
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
          <span className="w-3 shrink-0 font-mono text-3xs text-muted-foreground">{REVIEW_STATUS_LETTER[file.status]}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
            {cut > -1 && <span className="text-muted-foreground">{file.path.slice(0, cut + 1)}</span>}
            <span className="text-foreground">{file.path.slice(cut + 1)}</span>
          </span>
          {/* The one badge worth the width: this row is in the diff and was
              never in the transcript. Telar's own ignore rules are in neither,
              and get their author's name rather than the session's. */}
          {!reported && !registration && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal text-warning">
              unreported
            </Badge>
          )}
          {registration && (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-0 text-4xs font-normal"
              title="Telar’s own ignore rules — telar.yaml and .telar/ — added when this project was registered, not by this session"
            >
              setup
            </Badge>
          )}
          {/* Rewritten more than once on the way here. Git shows the net result
              and cannot say this; the transcript can. */}
          {edits !== undefined && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal" title={`The session wrote this ${edits} times`}>
              ×{edits}
            </Badge>
          )}
          {file.binary && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
              bin
            </Badge>
          )}
          <span className="shrink-0 font-mono text-3xs tabular-nums">
            {file.linesAdded ? <span className="text-success">+{file.linesAdded}</span> : null}
            {file.linesAdded && file.linesRemoved ? " " : null}
            {/* U+2212, same width as the plus — the reason the column lines up. */}
            {file.linesRemoved ? <span className="text-destructive">−{file.linesRemoved}</span> : null}
          </span>
        </button>
      </PanelRow>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-auto">
          {onOpenFile && <ContextMenuItem onClick={() => onOpenFile(file.path)}>Open in Editor</ContextMenuItem>}
          {onOpenInNewPanelTab && <ContextMenuItem onClick={() => onOpenInNewPanelTab(file.path)}>Open in a new panel tab</ContextMenuItem>}
          {(onOpenFile || onOpenInNewPanelTab) && <ContextMenuSeparator />}
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(file.path)}>Copy path</ContextMenuItem>
          {onInsertReference && (
            <ContextMenuItem onClick={() => onInsertReference(fileReference(file.path).text)}>Insert as reference</ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setOpen((current) => !current)}>{open ? "Collapse patch" : "Expand patch"}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open &&
        (failed ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">git could not produce a patch for this path.</p>
        ) : patch === undefined ? (
          <p className="flex items-center gap-2 px-4 pb-2 text-2xs text-muted-foreground">
            <Spinner className="size-3" /> reading the diff…
          </p>
        ) : patch === "" ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">Binary file — no textual diff.</p>
        ) : (
          <Patch patch={patch} />
        ))}
      {file.renamedFrom && <p className="px-4 pb-2 pl-[1.9rem] text-2xs text-muted-foreground">Renamed from {file.renamedFrom}</p>}
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
    <div className="border-b border-border bg-muted/25 px-4 py-2.5 text-2xs leading-relaxed">
      {review.unreported.length > 0 && (
        <p className="flex gap-1.5 text-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">
              {review.unreported.length} {review.unreported.length === 1 ? "file" : "files"} the transcript never mentioned
            </span>{" "}
            — an install, a build, or a formatter.
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
      setResult({ ok: false, text: cause instanceof EngineApiError ? cause.message : "The commit could not be sent." });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="border-t border-border p-3">
      {result && (
        <p className={cn("mb-2 rounded-md px-2.5 py-1.5 text-2xs leading-snug", result.ok ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
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
      <p className="mt-2 text-2xs leading-snug text-muted-foreground">
        Staging, branch switching and discarding are absent — irreversible next to a running agent. Use a terminal in{" "}
        <span className="break-all font-mono">{workspacePath}</span>.
      </p>
    </div>
  );
}

export function DiffSurface({
  sessionId,
  /** Present always; used when there is no session yet. */
  projectId,
  /** What the JOURNAL says this session wrote: path → how many times. The other
   *  half of the reconciliation — see `changedFiles` in right-panel.tsx. */
  reported,
  /** The session title, as the default commit message. */
  suggestion,
  /** A turn is running. Only used to hold the commit button. */
  active,
  filter,
  onFilterChange,
  onOpenFile,
  onOpenInNewPanelTab,
  onInsertReference,
}: {
  sessionId?: string;
  projectId?: string;
  reported: ReadonlyMap<string, number>;
  suggestion: string;
  active?: TurnState;
  /**
   * THIS INSTANCE'S FILTER — a folder or one file, and the whole of what makes
   * two Diff tabs different (#335).
   *
   * IT LIVES IN THE TAB'S PARAMS, NOT IN THIS COMPONENT, which is what makes it
   * an instance rather than a mood: the strip reads it for the label
   * ("Diff · src/"), the panel persists it with the rest of the arrangement, and
   * a surface remounted by a session switch comes back filtered the same way.
   * Local state here would be none of those things.
   */
  filter?: string;
  /** Rewrite the filter. An EMPTY string clears the param entirely — see the
   *  cockpit's handler — so a cleared field leaves a tab that reads "Diff".
   *  Absent hides the field, for a caller that has no params to keep. */
  onFilterChange?: (filter: string) => void;
  /** A changed file's row can open the file the Editor already draws — the
   *  panel derives this from its own `onOpenTab`, exactly as it does for
   *  LatexSurface, so no second route into the Editor is created here. */
  onOpenFile?: (path: string) => void;
  /** A row's path, reviewed in a second Diff tab filtered to it — see
   *  `ReviewFileRow`. The panel derives it from the same "open another
   *  instance" verb the "+" chooser uses. */
  onOpenInNewPanelTab?: (path: string) => void;
  /** Put a row's file reference into the message being written. */
  onInsertReference?: (text: string) => void;
}) {
  const [diff, setDiff] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  /**
   * A CANVAS REVIEWS ITS PROJECT.
   *
   * Before the first message there is no session and therefore no base, but
   * there is very much a repository — and "the tree already has twelve
   * uncommitted files" is exactly what a person wants to know before pointing
   * an agent at it. Same surface, same rows, one scope narrower: `HEAD…worktree`
   * instead of `base…worktree`, which the headline already knows how to say.
   */
  const load = useCallback(async () => {
    try {
      if (sessionId) setDiff((await api.sessionDiff(sessionId)).diff);
      else if (projectId) setDiff((await api.projectDiff(projectId)).diff);
      else return;
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId]);

  const readPatch = useCallback(
    (path: string, untracked: boolean) =>
      sessionId
        ? api.sessionFilePatch(sessionId, path, untracked ? { untracked: true } : {})
        : api.projectFilePatch(projectId!, path, untracked ? { untracked: true } : {}),
    [sessionId, projectId],
  );

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

  const review = useMemo(() => (diff ? reconcileReview(diff, reported) : undefined), [diff, reported]);
  /**
   * WHAT THIS TAB IS A REVIEW OF. Everything on screen below the commit box is
   * read out of this rather than out of `review`: the headline, the
   * reconciliation band and both row lists all have to be counting the same
   * files as the list under them.
   *
   * THE COMMIT BOX IS THE ONE EXCEPTION, and deliberately — it commits the
   * whole tree (`git add -A`), so it goes on naming the unfiltered figure. A
   * button reading "Commit 3 files" that committed forty-eight would be the
   * worst kind of lie this surface could tell.
   */
  const shown = useMemo(() => (review ? reviewUnderFilter(review, filter) : undefined), [review, filter]);
  /** The filter as it MEANS rather than as the field holds it — whitespace
   *  alone is not a filter, and neither is an empty string. Shown as typed
   *  otherwise, so the prose below and the tab's own label agree. */
  const trimmed = filter?.trim() || undefined;

  /** Built once and spread onto both row lists, so the two can never drift
   *  into offering different menus for the same kind of row. */
  const rowMenu = { ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {}), ...(onInsertReference ? { onInsertReference } : {}) };

  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="No project">
        Nothing to review yet.
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
  if (!diff || !review || !shown) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> reading the repository…
      </p>
    );
  }
  /**
   * THE DRIVE IS AWAY — issue #534, and it is checked BEFORE `repository`.
   *
   * `git` answers "not a git repository" for a path it cannot read, so an
   * unplugged drive landed on the empty state below and this panel read CLEAN:
   * no diff, nothing to review, as if the work had been finished. It had not
   * been looked at. The engine stamps what its own probe found on this answer
   * (see `SessionDiff.availability`), which is the only way this surface can
   * tell "no changes" from "nobody could look".
   */
  if (diff.availability === "unmounted") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The drive is not connected">
        This project lives on a drive that is not plugged in, so there is nothing to read — not nothing to review. Reconnect it and this comes back as it was.
      </PanelEmpty>
    );
  }
  if (diff.availability === "missing") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The project folder is gone">
        {diff.workspacePath} is not on this machine any more.
      </PanelEmpty>
    );
  }
  if (!diff.repository) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="Not a git repository">
        No diff to review.
      </PanelEmpty>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* THE HEADLINE ANSWERS THE QUESTION IN ONE LINE: how far back the
          comparison reaches, and how big the answer is. */}
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-2 text-2xs">
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
        <p className="mt-1 text-sm font-medium tabular-nums">{describeReview(shown)}</p>
        <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
          {/* WITHOUT A BASE THIS IS A SMALLER QUESTION, and saying so is the
              difference between an honest figure and a wrong one: a session
              that committed its work would otherwise review as having done
              nothing at all. */}
          {!sessionId
            ? "Everything uncommitted in this project right now."
            : diff.base
              ? "Everything this session changed, committed and uncommitted."
              : "No starting commit was recorded, so this counts only what is uncommitted."}
          {/* THE FILTER IS SAID OUT LOUD, because the figure above it is a
              count of a SUBSET and everything else on this line describes the
              whole. A tab you came back to an hour later has to be able to
              explain why it disagrees with the one beside it. */}
          {trimmed ? ` Filtered to ${trimmed} — ${review.filesChanged} ${review.filesChanged === 1 ? "file" : "files"} in all.` : ""}
          {diff.ahead !== undefined && diff.ahead > 0 ? ` ${diff.ahead} ahead of upstream.` : ""}
          {diff.truncated ? " The list below is capped; the figures above are not." : ""}
        </p>
        {/* THE FIELD IS THE INSTANCE'S IDENTITY, so it sits in the header where
            a tab's subject belongs — beside the branch it is a review of, not
            buried in a menu. Typing writes straight through to the tab's
            params: there is no local copy to fall out of step with the label,
            and clearing the field clears the param. */}
        {onFilterChange && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 focus-within:border-ring">
            <ListFilterIcon className="size-3 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={filter ?? ""}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder="Filter by folder or file"
              aria-label="Filter this review by path"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-2xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
            />
            {filter && (
              <button
                type="button"
                aria-label="Clear the filter"
                title="Clear the filter"
                onClick={() => onFilterChange("")}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* The reconciliation needs a TRANSCRIPT to disagree with. A canvas has
          none, so the band would be reporting every file as "never mentioned"
          by a session that has not said anything yet. */}
      {sessionId && <ReconciliationBand review={shown} />}
      <CommitList commits={diff.commits} />

      {shown.rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-2xs text-muted-foreground">
          {/* A FILTER THAT MATCHES NOTHING IS NOT AN EMPTY REVIEW, and saying
              "nothing differs" over a tree with forty changed files would send
              somebody looking for a bug in git. */}
          {trimmed ? (
            <>
              Nothing under <span className="font-mono">{trimmed}</span> differs.
              {review.rows.length > 0 && ` The rest of the review has ${review.rows.length} ${review.rows.length === 1 ? "file" : "files"}.`}
            </>
          ) : (
            <>
              Nothing differs from where this session started.
              {review.settled.length > 0 && " Everything it wrote has been put back or committed."}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Unreported rows lead. They are the ones a reviewer has not seen,
              and burying them in alphabetical order defeats the point. On a
              canvas there is no transcript, so NOTHING is unreported — badging
              every row would be reporting a disagreement with a conversation
              that has not happened. */}
          {sessionId && shown.rows.filter((row) => !row.reported).length > 0 && shown.rows.some((row) => row.reported) && (
            <PanelDivider label="not in the transcript" />
          )}
          {shown.rows
            .filter((row) => !row.reported)
            .map((row) => (
              <ReviewFileRow
                key={row.file.path}
                readPatch={readPatch}
                file={row.file}
                reported={!sessionId}
                {...(row.registration ? { registration: row.registration } : {})}
                {...rowMenu}
              />
            ))}
          {sessionId && shown.rows.some((row) => row.reported) && shown.rows.some((row) => !row.reported) && (
            <PanelDivider label="the session wrote these" />
          )}
          {shown.rows
            .filter((row) => row.reported)
            .map((row) => (
              <ReviewFileRow key={row.file.path} readPatch={readPatch} file={row.file} reported {...(row.edits ? { edits: row.edits } : {})} {...rowMenu} />
            ))}
        </div>
      )}

      <div className="mt-auto">
        {sessionId ? (
          /* `review`, NOT `shown`: the commit takes the whole tree, so the
             count on the button is the whole tree's even when the list above
             is filtered. See the note on `shown`. */
          <CommitBox
          sessionId={sessionId}
          suggestion={suggestion}
          files={review.filesChanged}
          busy={active === "running" || active === "claimed"}
          workspacePath={diff.workspacePath}
          onCommitted={() => void load()}
          />
        ) : (
          /* No session, no commit. Committing a project's existing uncommitted
             work from a canvas would be snapshotting somebody else's work under
             a conversation that has not started. */
          <p className="border-t border-border p-3 text-2xs leading-snug text-muted-foreground">
            The project&rsquo;s own uncommitted work, before this conversation starts.
          </p>
        )}
      </div>
    </div>
  );
}
