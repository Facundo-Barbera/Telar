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
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  GitBranchIcon,
  HardDriveIcon,
  GitCommitHorizontalIcon,
  ListFilterIcon,
  PilcrowIcon,
  RefreshCwIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react";
import type { GitFilePatch, GitFileChange, SessionDiff, TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import { reconcileReview, reviewFraming, REVIEW_STATUS_LETTER, unreportedFiles, type SessionReview } from "@/lib/session-review";
import { useDiffView, type DiffView } from "@/lib/diff-view";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { DiffCodeView } from "@/components/session/diff-code-view";
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
  view,
  open,
  onToggle,
  onOpenFile,
  onOpenInNewPanelTab,
  onInsertReference,
}: {
  /** Session-scoped or project-scoped — the row does not care which, which is
   *  what lets one surface serve a conversation and a canvas. */
  readPatch: (path: string, untracked: boolean) => Promise<{ file: GitFilePatch }>;
  file: GitFileChange;
  reported: boolean;
  /** How this reader likes a diff laid out. Passed down rather than read here
   *  so every open row in the list answers one toolbar, not its own. */
  view: DiffView;
  /**
   * WHETHER THIS ROW IS OPEN LIVES ON THE SURFACE (#694), not in the row.
   *
   * It was local state until the toolbar grew "collapse all" / "expand all" —
   * and a button that has to reach into forty children to close them is the
   * signal that the children were holding somebody else's state. The surface
   * owns the set; a row is told.
   */
  open: boolean;
  onToggle: () => void;
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
  /**
   * THE WHOLE ANSWER, not just its text — `patch: ""` alone could not say
   * whether this file is binary, identical, or unread (#654).
   *
   * STAMPED WITH THE READER THAT PRODUCED IT, because `readPatch` changes
   * identity when the whitespace toggle does: the flag is on the git command
   * (#694), so a patch in hand is an answer to the old question the moment it
   * flips. Holding the two together means the stale answer is DISCARDED IN THE
   * SAME EXPRESSION that notices it is stale — the "adjust state while
   * rendering" shape React documents for exactly this, rather than an effect
   * that repaints once with hunks nobody asked for any more.
   */
  const [answer, setAnswer] = useState<{ reader: typeof readPatch; patch?: GitFilePatch; failed: boolean }>({ reader: readPatch, failed: false });
  const current = answer.reader === readPatch ? answer : { reader: readPatch, failed: false };
  if (current !== answer) setAnswer(current);
  const { patch, failed } = current;
  const cut = file.path.lastIndexOf("/");

  useEffect(() => {
    if (!open || patch !== undefined || failed) return;
    let cancelled = false;
    void readPatch(file.path, file.status === "untracked")
      .then((result) => {
        if (!cancelled) setAnswer({ reader: readPatch, patch: result.file, failed: false });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ reader: readPatch, failed: true });
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
          onClick={onToggle}
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
          <ContextMenuItem onClick={onToggle}>{open ? "Collapse patch" : "Expand patch"}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open &&
        (failed ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">git could not produce a patch for this path.</p>
        ) : patch === undefined ? (
          <p className="flex items-center gap-2 px-4 pb-2 text-2xs text-muted-foreground">
            <Spinner className="size-3" /> reading the diff…
          </p>
        ) : /* GIT DID NOT ANSWER IS NOT A FACT ABOUT THE FILE — issue #654. An
               unread patch arrived here as the empty string and this branch
               rendered "Binary file", which is a specific, confident and wrong
               claim about the contents. */
        patch.incomplete ? (
          <p className="px-4 pb-2 text-2xs text-warning">
            {patch.incomplete === "timeout" ? "git did not answer in time — open it again." : "git could not read this file's diff."}
          </p>
        ) : patch.binary ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">Binary file — no textual diff.</p>
        ) : patch.patch === "" ? (
          // The third case the old `patch === ""` swallowed: git answered, and
          // its answer is that nothing in this file differs.
          <p className="px-4 pb-2 text-2xs text-muted-foreground">No textual difference.</p>
        ) : (
          /* THE RENDERER IS NOT OURS ANY MORE (#694) — see diff-code-view.tsx.
             The row above is still the file header, so the viewer is told not
             to draw its own; everything inside it is Pierre's, wearing this
             app's tokens through `.diff-code-view` in globals.css. */
          <div className="mx-3 mb-2 overflow-hidden rounded-md bg-card">
            <DiffCodeView patch={patch.patch} layout={view.layout} wrap={view.wrap} />
          </div>
        ))}
      {file.renamedFrom && <p className="px-4 pb-2 pl-[1.9rem] text-2xs text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

/**
 * HOW THE PATCHES BELOW ARE DRAWN — issue #694.
 *
 * SEPARATE FROM THE FILTER FIELD ABOVE IT, and the split is the point. The
 * filter says WHICH review this tab is; these say how this person reads one.
 * The first belongs to the tab and is persisted with the panel's arrangement;
 * the second belongs to the reader and is persisted once for the app (see
 * lib/diff-view.ts). Putting them in one strip would be two contracts in one
 * row, which is the mistake this issue's design refuses elsewhere.
 *
 * STACKED | SPLIT IS NOT GATED ON WIDTH. The instinct was to hide split below
 * some number of pixels; the reference does not, and is right. Wrapping is off
 * by default so a long line scrolls, and the measured line lengths in this
 * repository (p50 49, p90 82, p99 136) are documentation of what you will see
 * at a given width rather than a threshold that refuses you a layout you asked
 * for.
 *
 * COLLAPSE / EXPAND ALL IS ONE BUTTON, not two, because the two are never both
 * useful: with anything open the thing you want is to close it, and with
 * nothing open the only move left is to open. A pair would spend half its width
 * on a disabled control.
 */
export function DiffToolbar({
  view,
  setView,
  anyOpen,
  onToggleAll,
  expandable,
}: {
  view: DiffView;
  setView: (patch: Partial<DiffView>) => void;
  anyOpen: boolean;
  onToggleAll: () => void;
  /** No rows, nothing to collapse — the control goes rather than greys out. */
  expandable: boolean;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
      {/* A SEGMENTED CONTROL, which is what two exclusive layouts are. Written
          as a radiogroup rather than two buttons so the pair is one stop in the
          tab order and arrow keys move between them. */}
      <div role="radiogroup" aria-label="Diff layout" className="flex items-center rounded-md border border-input p-0.5">
        {(["stacked", "split"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={view.layout === option}
            onClick={() => setView({ layout: option })}
            className={cn(
              "rounded-[0.25rem] px-2 py-0.5 text-2xs capitalize transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              view.layout === option ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <DiffToolbarToggle
        label="Word wrap"
        icon={<WrapTextIcon className="size-3.5" />}
        pressed={view.wrap}
        onPressedChange={(next) => setView({ wrap: next })}
      />
      <DiffToolbarToggle
        label="Ignore whitespace"
        // `¶` is the mark for the thing being ignored, and it is the same glyph
        // every editor puts on this control.
        icon={<PilcrowIcon className="size-3.5" />}
        pressed={view.ignoreWhitespace}
        onPressedChange={(next) => setView({ ignoreWhitespace: next })}
      />
      {expandable && (
        <button
          type="button"
          onClick={onToggleAll}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {anyOpen ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
          {anyOpen ? "Collapse all" : "Expand all"}
        </button>
      )}
    </div>
  );
}

/** One of the toolbar's two on/off marks. `aria-pressed` rather than a checkbox
 *  because these change how the page is drawn, not what will be submitted. */
function DiffToolbarToggle({
  label,
  icon,
  pressed,
  onPressedChange,
}: {
  label: string;
  icon: React.ReactNode;
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "flex shrink-0 items-center rounded-md p-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

/**
 * WHAT GIT DID NOT ANSWER, IN THE ONE PLACE IT CHANGES A DECISION — issue #654.
 *
 * THE ENGINE FIX ALONE DOES NOT FIX THIS BUG, which is #650's lesson repeated:
 * `filesIncomplete` arriving on the answer is worth nothing while this surface
 * draws a review that timed out exactly as it draws a session that changed
 * nothing. An empty Diff panel is how a person decides a session did no work
 * and archives it — there is no search box to blame here and no short list to
 * look suspicious, so the surface has to say it out loud or nobody will know.
 *
 * ABOVE THE ROWS, NEVER IN PLACE OF THEM. The files that did arrive are real
 * changes, still worth reading and still about to be in the commit; replacing
 * them with an error would trade a misleading review for a useless one.
 *
 * THREE SENTENCES BECAUSE THEY ARE THREE DIFFERENT DOUBTS, and the point of the
 * engine carrying three flags rather than one is that a reader should distrust
 * the half of the screen that is actually unknown — a `git log` that was killed
 * says nothing whatever about the file list under it.
 *
 * "ASK GIT AGAIN" IS THE OFFER FOR A TIMEOUT, because that is the failure that
 * goes away on its own: the machine was busy. It is this surface's own refresh
 * rerun rather than a new request. A failure for another reason keeps the
 * button — it costs one read — but says what it is, so somebody who presses it
 * twice to no effect knows this is not a busy machine.
 */
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
    /* `tint-warning` rather than `bg-warning/10` (#691). This band carries a
       semantic fill AND semantic ink — `text-warning` sentences on 10% of
       --warning — so over the wash both ends of the pair were 90% desktop, and
       the one band whose whole job is to say "this list may be incomplete"
       became the least legible thing on the surface. Not the same case as
       ReconciliationBand's `bg-muted/25` above: that is a neutral separator
       under ordinary ink, which #434's light-under-glass floor already covers.
       The hairline keeps its alpha — a border is a mark, not a ground. */
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

/**
 * WHY THIS LIST IS EMPTY — three different claims that were one sentence.
 *
 * A FILTER THAT MATCHES NOTHING IS NOT AN EMPTY REVIEW: saying "nothing differs"
 * over a tree with forty changed files would send somebody looking for a bug in
 * git. And "nothing differs" is itself a CLAIM ABOUT THE CHECKOUT (#654), safe
 * only when the reads that would have contradicted it actually answered — this
 * is the exact conflation #650 found in the base picker's `"No matching refs."`,
 * arriving on the surface where it costs the most, because an empty review is
 * how somebody decides a session did no work.
 */
export function ReviewEmptyState({
  review,
  trimmed,
  filesIncomplete,
}: {
  review: SessionReview;
  /** The filter as it MEANS, not as the field holds it. */
  trimmed?: string;
  filesIncomplete?: SessionDiff["filesIncomplete"];
}) {
  return (
    <div className="px-4 py-6 text-center text-2xs text-muted-foreground">
      {trimmed ? (
        <>
          {/* "differs" is the claim; "was listed" is all that can be said over a
              read that was cut short — the filter's own sentence has to give way
              on the same word the unfiltered one does. */}
          Nothing under <span className="font-mono">{trimmed}</span> {filesIncomplete ? "was listed" : "differs"}.
          {review.rows.length > 0 && ` The rest of the review has ${review.rows.length} ${review.rows.length === 1 ? "file" : "files"}.`}
        </>
      ) : filesIncomplete ? (
        // The band above owns the explanation; this line only has to stop
        // repeating the claim underneath it.
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

/**
 * THE BAND THAT JUSTIFIES THE WHOLE SURFACE.
 *
 * Rendered only when there is something to say, and stated as a fact rather
 * than an alarm: side effects are normal — installs, builds, formatters — and
 * the point is that you should know they are in the commit before you make it.
 *
 * THE WARNING HALF IS GONE ON A SHARED CHECKOUT (#690) — see `reviewFraming`.
 * "The transcript never mentioned this" is evidence of nothing in a tree the
 * editor and every other local session also write to, and the band stated it as
 * an accusation. The SETTLED half stays: the journal claiming a write that the
 * diff does not have is the journal's own testimony about itself, and sharing
 * the checkout with somebody else does not weaken it.
 */
function ReconciliationBand({ review, journal }: { review: SessionReview; journal: boolean }) {
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
  countIncomplete,
  busy,
  workspacePath,
  onCommitted,
}: {
  sessionId: string;
  suggestion: string;
  files: number;
  /**
   * `files` IS A FLOOR, NOT THE COUNT — issue #654.
   *
   * This button runs `git add -A`, so it commits the real tree whatever this
   * surface managed to read. A label reading "Commit 3 files" over a review
   * whose file list was cut short by a timeout would commit forty-eight — the
   * same lie the note on `shown` forbids for the filter, arriving by a different
   * door. And `files === 0` must not disable it, because zero here may only mean
   * nobody could look.
   */
  countIncomplete?: boolean;
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
        /* `tint-success` rather than `bg-success/10` (#691): a sentence about
           what git just did, on the panel's own ground. The failure branch was
           always opaque (`bg-muted`); the success branch was 10% of a colour
           over the wash, which is the one of the two that could dissolve. */
        <p className={cn("mb-2 rounded-md px-2.5 py-1.5 text-2xs leading-snug", result.ok ? "tint-success text-success" : "bg-muted text-muted-foreground")}>
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
              {countIncomplete ? "Commit everything in the checkout" : `Commit ${files} ${files === 1 ? "file" : "files"}`}
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
          disabled={busy || (files === 0 && !countIncomplete)}
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
  const { view, setView } = useDiffView();
  /**
   * WHICH ROWS ARE OPEN, held here rather than in the rows (#694) — "collapse
   * all" is a button that has to close forty children, and a button that reaches
   * into its children is the signal the children were holding the wrong state.
   *
   * BY PATH RATHER THAN BY INDEX, so a refresh that adds a file above an open
   * one does not silently move the open patch to a different row.
   */
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = useCallback((path: string) => {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

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

  /**
   * IGNORING WHITESPACE IS PART OF THE REQUEST, not part of the rendering
   * (#694) — git decides which hunks exist. So the toggle is in this callback's
   * dependencies, and an open row re-reads when it flips: see the effect in
   * `ReviewFileRow` that watches this function's identity.
   */
  const readPatch = useCallback(
    (path: string, untracked: boolean) => {
      const options = { ...(untracked ? { untracked: true } : {}), ...(view.ignoreWhitespace ? { ignoreWhitespace: true } : {}) };
      return sessionId ? api.sessionFilePatch(sessionId, path, options) : api.projectFilePatch(projectId!, path, options);
    },
    [sessionId, projectId, view.ignoreWhitespace],
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

  /**
   * "ANY" RATHER THAN "ALL", so the button's two states cover the three real
   * ones. With some rows open, what you want is to close them; only a list
   * where nothing is open has "expand" as its obvious next move.
   *
   * COUNTED OVER THE ROWS THIS TAB SHOWS, so "expand all" in a tab filtered to
   * `apps/web` does not quietly open forty files in `apps/engine` that this
   * reader cannot see and will not close.
   */
  const shownPaths = shown?.rows.map((row) => row.file.path) ?? [];
  const anyOpen = shownPaths.some((path) => openPaths.has(path));
  /** Plain, not memoised: it is handed to the toolbar's one button, never to
   *  the forty rows, so a fresh identity each render costs nothing. */
  const toggleAll = () => setOpenPaths((current) => (shownPaths.some((path) => current.has(path)) ? new Set() : new Set(shownPaths)));

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

  /**
   * WHOSE CHANGES THESE ARE, decided once and read by the headline, the band
   * and the row lists — the three places that disagreed (#690). A plain fold
   * rather than a memo: it is three comparisons and a string, and every reader
   * of it is in the JSX below.
   */
  const framing = reviewFraming(diff, shown, Boolean(sessionId));

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
        {/* THE FIGURE IS THE FIRST THING READ, so it is the first thing that has
            to stop being a fact when it is a floor (#654). The band below says
            why; this only has to make sure nobody's eye lands on a bold "0
            files" and takes it for the answer. WHOSE figure it is comes from
            the fold (#690); how COMPLETE it is stays here, being a property of
            the read rather than of the checkout. */}
        <p className={cn("mt-1 text-sm font-medium tabular-nums", diff.filesIncomplete && "text-warning")}>
          {framing.headline}
          {diff.filesIncomplete && <span className="ml-1.5 text-2xs font-normal">· incomplete</span>}
        </p>
        <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
          {/* WHICH QUESTION THESE FIGURES ANSWER — `reviewFraming`. Without a
              base it is a smaller question; over a read git cut short it is "as
              much as git reported" rather than "everything" (#654); and on a
              SHARED checkout it is a question about the checkout rather than
              about this session (#690), so the sentence says so instead of
              claiming work the session may never have done. */}
          {framing.note}
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

      {/* HOW THE PATCHES ARE DRAWN, under the header that says WHICH review this
          is and above the bands that say how much to trust it. */}
      <DiffToolbar view={view} setView={setView} anyOpen={anyOpen} onToggleAll={toggleAll} expandable={shownPaths.length > 0} />

      {/* FIRST OF THE BANDS, because it is the only one that can make everything
          under it untrustworthy — including the other band's own figures. */}
      <DiffUnknownBand diff={diff} onRetry={load} />
      {/* The reconciliation needs a TRANSCRIPT to disagree with. A canvas has
          none, so the band would be reporting every file as "never mentioned"
          by a session that has not said anything yet — and a shared checkout
          has one that cannot speak for the tree (#690, `framing.journal`). */}
      {sessionId && <ReconciliationBand review={shown} journal={framing.journal} />}
      <CommitList commits={diff.commits} />

      {shown.rows.length === 0 ? (
        <ReviewEmptyState review={review} trimmed={trimmed} filesIncomplete={diff.filesIncomplete} />
      ) : (
        <div className="flex flex-col">
          {/* Unreported rows lead. They are the ones a reviewer has not seen,
              and burying them in alphabetical order defeats the point. On a
              canvas there is no transcript, so NOTHING is unreported — badging
              every row would be reporting a disagreement with a conversation
              that has not happened. A SHARED CHECKOUT is the same case for a
              different reason (#690): the transcript is real, but it was never
              the only thing writing to this tree, so its silence about a row
              accuses nobody. */}
          {framing.journal && shown.rows.filter((row) => !row.reported).length > 0 && shown.rows.some((row) => row.reported) && (
            <PanelDivider label="not in the transcript" />
          )}
          {shown.rows
            .filter((row) => !row.reported)
            .map((row) => (
              <ReviewFileRow
                key={row.file.path}
                readPatch={readPatch}
                file={row.file}
                reported={!framing.journal}
                view={view}
                open={openPaths.has(row.file.path)}
                onToggle={() => toggleRow(row.file.path)}
                {...(row.registration ? { registration: row.registration } : {})}
                {...rowMenu}
              />
            ))}
          {framing.journal && shown.rows.some((row) => row.reported) && shown.rows.some((row) => !row.reported) && (
            <PanelDivider label="the session wrote these" />
          )}
          {shown.rows
            .filter((row) => row.reported)
            .map((row) => (
              <ReviewFileRow
                key={row.file.path}
                readPatch={readPatch}
                file={row.file}
                reported
                view={view}
                open={openPaths.has(row.file.path)}
                onToggle={() => toggleRow(row.file.path)}
                {...(row.edits ? { edits: row.edits } : {})}
                {...rowMenu}
              />
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
          {...(diff.filesIncomplete ? { countIncomplete: true } : {})}
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
