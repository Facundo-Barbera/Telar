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
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
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
import type {
  DiffBaseOption,
  FilePatchOptions,
  GitFilePatch,
  GitFileChange,
  GitHubPullCreateRefusal,
  GitHubPullCreateResult,
  GitPatchIncomplete,
  GitPushRefusal,
  GitPushResult,
  GitRefEntry,
  SessionDiff,
  TurnState,
} from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { PULL_CREATE_REFUSAL, PUSH_REFUSAL } from "@/lib/github-forge";
import { fmtAgo } from "@/lib/format";
import { describeReview, reconcileReview, reviewFraming, REVIEW_STATUS_LETTER, unreportedFiles, type SessionReview } from "@/lib/session-review";
import { useDiffView, type DiffView } from "@/lib/diff-view";
import { diffBaseFor, scopesFor, type DiffScopeKind, type DiffTab } from "@/lib/diff-scope";
import { turnFor, turnLabel, type DiffTurn } from "@/lib/diff-turns";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { DiffCodeView, readPatchShape, type PatchReading } from "@/components/session/diff-code-view";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/**
 * HOW LONG THE SCOPE PICKER'S TWO LISTS GET.
 *
 * Both are menus inside a panel, and a menu you scroll to reach the thing you
 * wanted is a menu that should have been a search field — which is a bigger
 * control than either list earns. The refs the engine hands over are newest
 * first and already capped on its side; the turns are newest first and the one
 * anybody wants is at the top, because the question is "what did it JUST do".
 */
const MAX_BASE_REFS = 12;
const MAX_TURN_OPTIONS = 12;

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
 * WHICH WITNESS A TURN'S FIGURES COME FROM — issue #741, in four sentences
 * rather than one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE SENTENCE THIS REPLACES SAID "the agent's own patches, not the
 * checkout", which was true of every turn when #694 wrote it and is now true of
 * some of them. A surface that went on saying it over a real git range would be
 * #690's defect committed a third time — a sentence true of one mode stated
 * over another — so each state says what it actually is.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * AND THE SHARED-CHECKOUT CAVEAT RIDES THE ANCHORED ARM, because that is the
 * only arm it is about. In a `local` session `before..after` is "what the
 * REPOSITORY did while this turn ran", not "what this turn did": agents commit
 * under the owner's own identity, so an author filter decides nothing and a
 * timestamp filter is a guess wearing a number. `SessionDiff.shared` is already
 * set for exactly this mode (#690) and is reused rather than re-derived — and
 * it says the OTHER half too, which the single sentence could not: in a
 * worktree session the range is as close to "this turn's work" as anything in
 * this repository gets.
 */
function turnNote(turn: DiffTurn, diff: SessionDiff | undefined): string {
  const anchored = Boolean(turn.anchor?.before && turn.anchor.after);
  if (anchored) {
    const committed = turn.anchor?.before !== turn.anchor?.after;
    const range = committed
      ? "What git says changed between where this turn started and where it ended."
      : "This turn committed nothing, so this is what git says changed since it started — including anything written after it ended.";
    return diff?.shared === true
      ? `${range} This checkout is shared with your editor and with every other local session on it, so some of this may not be this turn's.`
      : `${range} This session owns its checkout, so this is as close to one turn's work as git can say.`;
  }
  if (turn.anchor?.read) {
    return "Where the repository stood when this turn ran was never read, so this is the agent's own reported patches rather than git.";
  }
  return "What this turn reported writing — the agent's own patches, not the checkout. Git may disagree, and the working-tree scope is where you would see it.";
}

/**
 * WHAT ONE ROW ASKS GIT FOR — every option on a patch read, in one expression.
 *
 * A FUNCTION RATHER THAN AN OBJECT LITERAL INSIDE THE CALLBACK, because this is
 * exactly where #694's dead toggle lived: three fields spread into a request,
 * one of them silently absent, and TypeScript checking nothing because the
 * value was not a literal at the call site. It is the same reason
 * `diffTabParams` is one writer — the shape has more than one contributor and
 * no natural place to notice a missing one.
 *
 * PURE, AND EXPORTED FOR ITS TEST: what the row asks for can then be asserted
 * without a poll, a fetch, or a mounted surface.
 */
export function patchRequestFor(file: GitFileChange, view: DiffView, base: DiffBaseOption): FilePatchOptions {
  return {
    /** Untracked files are in no diff at all — see the engine's `sessionFilePatch`. */
    ...(file.status === "untracked" ? { untracked: true } : {}),
    /** GIT decides which hunks exist, not the renderer (#694). */
    ...(view.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    /** BOTH PATHS OR GIT CALLS IT A NEW FILE (#694). The list already paired
     *  them with `--find-renames`; this hands that pairing on rather than
     *  making the engine re-derive it from a second full diff. */
    ...(file.renamedFrom ? { renamedFrom: file.renamedFrom } : {}),
    /** Last, so the scope's base cannot be shadowed by anything above it. */
    ...base,
  };
}

/**
 * WHICH WITNESS A ROW'S PATCH CAME FROM — issue #694, and #741's argument
 * applied one level down.
 *
 * `unstaged` and `branch` ask GIT. `turn` does not ask anything: its patch is
 * the one the agent's own tool reported, already in hand. So a row in the turn
 * scope that said "git could not read this file's diff" was naming a party that
 * was never consulted — #690's defect in miniature, a true-sounding sentence
 * about the wrong subject, and on the one scope whose whole design point is
 * that it names its witness.
 */
type PatchWitness = "git" | "journal";

/**
 * WHAT EACH WAY OF NOT HAVING THE WHOLE PATCH SAYS — one sentence per member of
 * `GitPatchIncomplete` per witness, so adding a member to the contract makes
 * this fail to compile rather than fall through to the wrong sentence.
 *
 * `truncated` IS THE ONE THAT NAMES A SIZE, because it is the only one where
 * hunks are drawn underneath it: the reader has to know that what they are
 * scrolling stops early rather than ends.
 */
const INCOMPLETE_PATCH: Record<GitPatchIncomplete, Record<PatchWitness, string>> = {
  timeout: {
    git: "git did not answer in time — open it again.",
    // No read to time out; kept honest rather than clever in case one appears.
    journal: "This turn's patch for the file did not arrive.",
  },
  failed: {
    git: "git could not read this file's diff.",
    journal: "This turn reported writing this file without a patch for it.",
  },
  truncated: {
    git: "The engine stopped reading this patch at its size limit, so what follows may not be the whole change.",
    journal: "This turn's patch was cut short when it was recorded, so what follows may not be the whole change.",
  },
};

/**
 * WHAT A PATCH WITH NO HUNKS IS ABOUT — issue #694, §2.3.
 *
 * `chmod +x` on a script an agent just wrote is not exotic; it is most
 * scaffolding runs. git emits three lines and no hunks, the patch is therefore
 * NOT empty, and the "No textual difference" branch above never fires — so the
 * row expanded into nothing at all: no lines, no explanation, no error. The
 * library had parsed it perfectly (`mode=100755 prevMode=100644 hunks=0`) and
 * was told not to draw a file header, which is the only place it can say so.
 *
 * DRAWN AS A SENTENCE ON TELAR'S ROW rather than by re-enabling that header,
 * because Telar's argument for `disableFileHeader` still holds: its own row IS
 * the header, and two headers are two answers to "which file is this".
 * `old mode 100644 → new mode 100755` is a sentence, not a viewer.
 *
 * A PURE RENAME IS THE SAME SHAPE once the engine passes both paths, so fixing
 * that without this would have turned one wrong answer into one blank one.
 */
function noHunkSentence(file: NonNullable<PatchReading["file"]>): string {
  const parts: string[] = [];
  if (file.prevName && file.prevName !== file.name) parts.push(`Moved from ${file.prevName}`);
  if (file.mode && file.prevMode && file.mode !== file.prevMode) parts.push(`Mode ${file.prevMode} → ${file.mode}`);
  // Neither — a whole-file read whose hunks were all suppressed, which is what
  // `-w` does to a re-indentation. "Nothing differs" is exactly what the reader
  // asked to be told, so it is said rather than left as an empty box.
  if (parts.length === 0) return "No lines differ.";
  return `${parts.join(" · ")}. No lines differ.`;
}

/**
 * One changed file. The patch is fetched WHEN OPENED rather than carried on the
 * review, because a two-hundred-file review with every patch is a megabyte on a
 * timer for content nobody asked to see.
 *
 * EXPORTED FOR ITS TESTS, like `DiffUnknownBand` and `ReviewEmptyState` beside
 * it: what an opened row says about a patch it could not fully read is decided
 * here, and the surface around it needs a poll before it renders anything.
 */
export function ReviewFileRow({
  readPatch,
  file,
  reported,
  edits,
  registration,
  view,
  open,
  witness = "git",
  onToggle,
  onOpenFile,
  onOpenInNewPanelTab,
  onInsertReference,
}: {
  /** Session-scoped or project-scoped — the row does not care which, which is
   *  what lets one surface serve a conversation and a canvas. */
  /**
   * THE WHOLE ROW, NOT JUST ITS PATH (#694). A renamed file's patch has to be
   * read with BOTH paths or git reports it as a brand-new file — and the only
   * party that knows the old one is the list this row came from, so the row
   * hands over the record rather than a path and a flag derived from it.
   */
  readPatch: (file: GitFileChange) => Promise<{ file: GitFilePatch }>;
  /**
   * WHO ANSWERED — `git` for the working tree and branch scopes, `journal` for
   * a turn's own reported patches. Only the sentences about a MISSING patch
   * depend on it, which is exactly where naming the wrong party is a claim
   * rather than a wording choice. Defaults to git, because two of the three
   * scopes are git and a row with no scope is a project's.
   */
  witness?: PatchWitness;
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
    void readPatch(file)
      .then((result) => {
        if (!cancelled) setAnswer({ reader: readPatch, patch: result.file, failed: false });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ reader: readPatch, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // `file.path`/`status`/`renamedFrom` rather than `file`: the row is rebuilt
    // on every poll, so the object's identity changes fifteen seconds after it
    // was last read while every field in it stays the same — and a re-read on
    // that would put a spinner over a patch nobody asked to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patch, failed, readPatch, file.path, file.status, file.renamedFrom]);

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
          /* The read itself threw — a dead engine, a rejected request. Named by
             witness for the same reason the band below is (#694): the turn
             scope resolves its patch from the journal already in hand and never
             makes a request that could fail this way. */
          <p className="px-4 pb-2 text-2xs text-muted-foreground">
            {witness === "git" ? "git could not produce a patch for this path." : "This turn's patch for the file could not be read."}
          </p>
        ) : patch === undefined ? (
          <p className="flex items-center gap-2 px-4 pb-2 text-2xs text-muted-foreground">
            <Spinner className="size-3" /> reading the diff…
          </p>
        ) : /* GIT DID NOT ANSWER IS NOT A FACT ABOUT THE FILE — issue #654. An
               unread patch arrived here as the empty string and this branch
               rendered "Binary file", which is a specific, confident and wrong
               claim about the contents.

               A TRUNCATED PATCH IS THE THIRD CASE AND IT IS NOT AN ABSENCE
               (#694): git answered at length and the engine stopped listening
               at its output bound, so there ARE hunks and they are real. The
               band says how much to trust them and the viewer below still
               draws them — hiding a megabyte of correct hunks because the
               other two megabytes are missing would be the opposite mistake. */
        patch.incomplete ? (
          <>
            <p className="px-4 pb-2 text-2xs text-warning">{INCOMPLETE_PATCH[patch.incomplete][witness]}</p>
            {patch.patch !== "" && <PatchBody patch={patch.patch} view={view} />}
          </>
        ) : patch.binary ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">Binary file — no textual diff.</p>
        ) : patch.patch === "" ? (
          // The third case the old `patch === ""` swallowed: git answered, and
          // its answer is that nothing in this file differs.
          <p className="px-4 pb-2 text-2xs text-muted-foreground">No textual difference.</p>
        ) : (
          <PatchBody patch={patch.patch} view={view} />
        ))}
      {file.renamedFrom && <p className="px-4 pb-2 pl-[1.9rem] text-2xs text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

/**
 * THE PATCH ITSELF, AND WHETHER IT WAS READABLE — issue #694, step 1.
 *
 * THE RENDERER IS NOT OURS (see diff-code-view.tsx). The row above is the file
 * header, so the viewer is told not to draw its own; everything inside it is
 * Pierre's, wearing this app's tokens through `.diff-code-view` in globals.css.
 *
 * WHAT IS OURS IS SAYING WHEN IT DID NOT WORK. The library RECOVERS from a
 * malformed patch with a `console.error` nobody sees, so a patch cut mid-line,
 * a truncation marker, or a header it mistook for a rename all drew as a
 * confident, plausible, wrong answer — and no test could tell that apart from a
 * correct render. The parse is asked once here and its complaint becomes a band
 * the reader can act on.
 *
 * THE VIEWER IS STILL MOUNTED UNDER THE BAND, because the library's recovery is
 * usually most of the patch and a warning over real hunks beats an empty box.
 */
function PatchBody({ patch, view }: { patch: string; view: DiffView }) {
  const reading = useMemo(() => readPatchShape(patch), [patch]);
  /* A CHANGE WITH NO HUNKS IS STILL A CHANGE — see `noHunkSentence`. Only when
     the parse was clean and described exactly one file: a complaint means the
     zero is the parser's failure rather than the file's shape, and the viewer
     below is then the more honest thing to show. */
  const noHunks = !reading.complaint && reading.files === 1 && reading.file?.hunks === 0 ? reading.file : undefined;
  return (
    <>
      {reading.complaint && (
        <p className="px-4 pb-2 text-2xs text-warning">
          This patch did not parse cleanly, so what is drawn below may be wrong or incomplete.{" "}
          <span className="font-mono text-3xs">{reading.complaint}</span>
        </p>
      )}
      {/* ONE ROW IS ONE FILE. More than one means a pathspec reached a
          neighbour (#694, §2.6) — the row's name and the hunks under it are
          then about different files, which is the hardest wrong answer to
          notice and the reason this is said rather than drawn over. */}
      {reading.files > 1 && (
        <p className="px-4 pb-2 text-2xs text-warning">
          This patch describes {reading.files} files, and this row is one file.
        </p>
      )}
      {noHunks ? (
        <p className="px-4 pb-2 text-2xs text-muted-foreground">{noHunkSentence(noHunks)}</p>
      ) : (
        <div className="mx-3 mb-2 overflow-hidden rounded-md bg-card">
          <DiffCodeView patch={patch} layout={view.layout} wrap={view.wrap} />
        </div>
      )}
    </>
  );
}

/** What each scope is called, and the one-line answer to "what am I looking
 *  at" — read by the picker's rows and by nothing else. */
const SCOPE_LABEL: Record<DiffScopeKind, string> = {
  unstaged: "Working tree",
  branch: "Since a base",
  turn: "One turn",
};

const SCOPE_BLURB: Record<DiffScopeKind, string> = {
  unstaged: "Everything uncommitted in this checkout, right now",
  branch: "Everything since a commit you choose",
  turn: "What one turn reported writing — the agent's own patches",
};

/**
 * WHICH QUESTION THIS TAB IS ASKING — issue #694, and the fix for #690 at the
 * root rather than at the sentence.
 *
 * THE DEFAULT IS THE WORKING TREE, and that is the whole point. The surface
 * used to answer one question — the session's own base — and print it as
 * "everything this session changed", which is false in a `local` session
 * sharing the checkout with an editor and three other sessions. #690 made the
 * sentence honest; this makes the DEFAULT QUESTION one whose honest answer is
 * the same in both modes, so there is nothing left to apologise for.
 *
 * A MENU RATHER THAN A SEGMENTED CONTROL, unlike Stacked|Split in the toolbar
 * below, and the difference is that two of these three carry an argument: a
 * base, or a turn. A segment cannot hold one, and the width of the panel is
 * not going to change its mind about that.
 */
function DiffScopePicker({
  tab,
  onTabChange,
  hasSession,
  refs,
  turns,
  sessionBase,
}: {
  tab: DiffTab;
  onTabChange?: (tab: DiffTab) => void;
  hasSession: boolean;
  refs?: readonly GitRefEntry[];
  turns?: readonly DiffTurn[];
  /** The session's own recorded base, for naming the default `branch` choice
   *  as what it is rather than as a blank. */
  sessionBase?: string;
}) {
  const offered = scopesFor(hasSession);
  /** What the trigger says. The scope's name, and then its ARGUMENT when it has
   *  one — a picker reading "Since a base" over a list built from `origin/main`
   *  makes the reader open the menu to find out what they are looking at. */
  const summary =
    tab.kind === "branch"
      ? tab.base ?? (sessionBase ? `${sessionBase.slice(0, 8)} — where this session started` : SCOPE_LABEL.branch)
      : tab.kind === "turn"
        ? turnLabel(turnFor(turns ?? [], tab.turn) ?? { runId: "", at: 0, files: [], patches: new Map() })
        : SCOPE_LABEL.unstaged;

  if (!onTabChange) return <span className="min-w-0 truncate text-muted-foreground">{summary}</span>;

  const chosenTurn = turnFor(turns ?? [], tab.turn);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="What this Diff is looking at"
            title="What this Diff is looking at"
            className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
          />
        }
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {/* EVERY LABEL INSIDE ITS GROUP — the house rule `dropdown-menu.test.ts`
            enforces, and the reason is the one it gives: a label dropped
            straight into the content is announced as an item. */}
        <DropdownMenuRadioGroup value={tab.kind} onValueChange={(next) => onTabChange({ ...tab, kind: next as DiffScopeKind })}>
          <DropdownMenuLabel>Looking at</DropdownMenuLabel>
          {offered.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind} className="items-start">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{SCOPE_LABEL[kind]}</span>
                <span className="text-2xs text-muted-foreground">{SCOPE_BLURB[kind]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {/* THE ARGUMENT FOR THE CHOSEN SCOPE, in the same menu rather than a
            second one: picking "since a base" and then having to find where to
            say WHICH base is two gestures for one decision. */}
        {tab.kind === "branch" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={tab.base ?? ""} onValueChange={(next) => onTabChange({ ...tab, base: next })}>
              <DropdownMenuLabel>Base</DropdownMenuLabel>
              {/* EMPTY IS THE SESSION'S OWN BASE, which is a real choice and not
                  a blank: it is the comparison this surface made before the
                  selector existed, and the one a reader coming back for "what
                  has this session done" wants. A canvas has no such base, so
                  the row is not offered there rather than being offered and
                  answering the same as the working tree. */}
              {hasSession && (
                <DropdownMenuRadioItem value="">
                  <span className="truncate">
                    Where this session started
                    {sessionBase ? <span className="ml-1.5 font-mono text-2xs text-muted-foreground">{sessionBase.slice(0, 8)}</span> : null}
                  </span>
                </DropdownMenuRadioItem>
              )}
              {(refs ?? []).slice(0, MAX_BASE_REFS).map((ref) => (
                <DropdownMenuRadioItem key={ref.name} value={ref.name}>
                  <span className="truncate font-mono text-2xs">{ref.name}</span>
                </DropdownMenuRadioItem>
              ))}
              {refs !== undefined && refs.length === 0 && <DropdownMenuLabel>No other refs to compare against.</DropdownMenuLabel>}
            </DropdownMenuRadioGroup>
          </>
        )}
        {tab.kind === "turn" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={chosenTurn?.runId ?? ""} onValueChange={(next) => onTabChange({ ...tab, turn: next })}>
              <DropdownMenuLabel>Turn</DropdownMenuLabel>
              {(turns ?? []).slice(0, MAX_TURN_OPTIONS).map((option) => (
                <DropdownMenuRadioItem key={option.runId} value={option.runId}>
                  <span className="min-w-0 flex-1 truncate">{turnLabel(option)}</span>
                  <span className="ml-2 shrink-0 text-2xs text-muted-foreground">{fmtAgo(option.at)}</span>
                </DropdownMenuRadioItem>
              ))}
              {turns !== undefined && turns.length === 0 && <DropdownMenuLabel>No turn has reported writing a file yet.</DropdownMenuLabel>}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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

/**
 * THE TWO PUBLISHING ARMS — issue #670.
 *
 * ── WHY TWO, AND WHY THEY ARE NOT ONE BUTTON ────────────────────────────────
 * They are two capabilities with two different portability stories. `git push`
 * needs git and a remote — any remote: GitLab, Gitea, a bare repository on a
 * NAS. `gh pr create` needs `gh` and a GitHub one. Folding them into a single
 * "publish" gesture would make the portable half hostage to the unportable one:
 * a GitLab user who can push perfectly well would get one button that cannot
 * work in place of one that can. So push is offered wherever it is possible,
 * and the pull-request arm is simply ABSENT — not disabled, not broken —
 * wherever `gh` has nothing to offer.
 *
 * ── ARM, THEN CONFIRM, AND THE SECOND PRESS SPELLS IT OUT ───────────────────
 * The merge footer's template, for the merge footer's reason: this is an
 * outward-facing act in a panel somebody is dragging tabs around in, and a
 * single-press primary button is a mis-click away from publishing a branch.
 * The armed sentence names the branch, the remote and the count, so the thing
 * being confirmed is the thing that will happen.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 * No force, no `--delete`, no "push all branches", and no offer to force after
 * a `rejected` refusal — the sentence for that one names a pull instead. The
 * engine cannot do any of them (`apps/engine/src/git.ts` fixes the argv and
 * `scripts/source-invariants.mjs` fails the build on a second one), and this
 * surface does not ask.
 */
export function PublishBox({
  sendPush,
  sendPullRequest,
  github,
  branch,
  /** Commits this branch has that its upstream does not. ABSENT means there is
   *  no upstream at all — a branch nobody has published yet, which is a
   *  different sentence from "nothing to push" and the common case here. */
  ahead,
  /** Commits since the session's base, as a floor for the first-push sentence
   *  when there is no upstream to count against. */
  commitsSinceBase,
  busy,
  onPublished,
  suggestion,
}: {
  /**
   * THE TWO VERBS, HANDED IN RATHER THAN REACHED FOR.
   *
   * This component decides what a reader sees and when an outward-facing act is
   * allowed to happen; which HTTP route carries it is `DiffSurface`'s business,
   * and it already holds the session id this needs. Taking them as props is the
   * same split `diff-unknown.test.tsx` names — the half that decides is the
   * half handed the answer — and it is what lets the arm-then-confirm rule be
   * tested by watching a call list rather than by replacing the engine client
   * for every other test sharing this process.
   */
  sendPush: () => Promise<GitPushResult>;
  sendPullRequest: (input: { title: string; body?: string }) => Promise<GitHubPullCreateResult>;
  /**
   * Whether `gh` has anything to offer for this project — the whole of what
   * decides if the second arm exists.
   *
   * `undefined` IS "NOBODY HAS ASKED YET" AND THE ARM STAYS HIDDEN THROUGH IT.
   * A button that appears a second after the panel settles is worse than one
   * that appears with it, and the read behind this is a `gh` round trip (see
   * `DiffSurface`, which owns it for the same reason it owns the ref read).
   *
   * ONE BOOLEAN RATHER THAN THE FIVE REASONS. `not_installed`,
   * `not_authenticated`, `not_github` and `no_repository` mean four different
   * things on the forge panel, where those four sentences belong. They mean one
   * thing here: there is no pull request to open.
   */
  github?: boolean;
  branch: string;
  ahead?: number;
  commitsSinceBase: number;
  busy: boolean;
  onPublished: () => void;
  /** The session title, as the default pull-request title — the same default
   *  and the same reasoning as the commit box's. */
  suggestion: string;
}) {
  const [armed, setArmed] = useState<"push" | "pull">();
  const [working, setWorking] = useState(false);
  const [pushProblem, setPushProblem] = useState<{ refusal: GitPushRefusal; message?: string }>();
  const [pullProblem, setPullProblem] = useState<{ refusal: GitHubPullCreateRefusal; message?: string; url?: string }>();
  const [opened, setOpened] = useState<{ url: string; number?: number }>();
  const [title, setTitle] = useState(suggestion);
  const [body, setBody] = useState("");

  const published = ahead !== undefined;
  const pushable = !published || ahead > 0;
  const count = published ? ahead : commitsSinceBase;

  const push = async () => {
    setWorking(true);
    setPushProblem(undefined);
    try {
      const result = await sendPush();
      if (result.pushed) {
        setArmed(undefined);
        onPublished();
        return;
      }
      setPushProblem({ refusal: result.refusal, ...(result.message ? { message: result.message } : {}) });
    } catch (cause) {
      setPushProblem({ refusal: "failed", message: cause instanceof EngineApiError ? cause.message : "The push could not be sent." });
    } finally {
      setWorking(false);
      setArmed(undefined);
    }
  };

  const openPull = async () => {
    setWorking(true);
    setPullProblem(undefined);
    try {
      const result = await sendPullRequest({ title, ...(body.trim() ? { body } : {}) });
      if (result.opened) {
        setArmed(undefined);
        setOpened({ url: result.url, ...(result.number ? { number: result.number } : {}) });
        onPublished();
        return;
      }
      setPullProblem({
        refusal: result.refusal,
        ...(result.message ? { message: result.message } : {}),
        ...(result.url ? { url: result.url } : {}),
      });
    } catch (cause) {
      setPullProblem({
        refusal: "failed",
        message: cause instanceof EngineApiError ? cause.message : "The pull request could not be sent.",
      });
    } finally {
      setWorking(false);
      setArmed(undefined);
    }
  };

  return (
    <div className="border-t border-border px-3 py-2">
      <p className="mb-1.5 truncate font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">publish {branch}</p>

      {/* A LINK, NOT A SENTENCE ABOUT A LINK. The pull request exists; the only
          useful thing left on this surface is the way to it. */}
      {opened && (
        <p className="mb-2 flex items-start gap-1.5 rounded-md tint-success px-2.5 py-1.5 text-2xs leading-snug text-success">
          <GitPullRequestArrowIcon className="mt-0.5 size-3.5 shrink-0" />
          <a href={opened.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all underline underline-offset-2">
            {opened.number ? `Opened #${opened.number}` : "Pull request opened"}
          </a>
        </p>
      )}

      {pushProblem && (
        <PublishProblem onDismiss={() => setPushProblem(undefined)}>
          {PUSH_REFUSAL[pushProblem.refusal]}
          {pushProblem.message && <span className="block text-muted-foreground">{pushProblem.message}</span>}
        </PublishProblem>
      )}
      {pullProblem && (
        <PublishProblem onDismiss={() => setPullProblem(undefined)}>
          {PULL_CREATE_REFUSAL[pullProblem.refusal]}
          {pullProblem.url && (
            <a href={pullProblem.url} target="_blank" rel="noreferrer" className="block break-all underline underline-offset-2">
              {pullProblem.url}
            </a>
          )}
          {pullProblem.message && !pullProblem.url && <span className="block text-muted-foreground">{pullProblem.message}</span>}
        </PublishProblem>
      )}

      {armed === "push" ? (
        <div className="flex flex-col gap-2">
          <p className="text-2xs leading-snug">
            Push <span className="font-mono">{branch}</span> to <span className="font-mono">origin</span>
            {count > 0 ? ` — ${count} ${count === 1 ? "commit" : "commits"}` : ""}?{" "}
            <span className="text-muted-foreground">
              {published
                ? "This appends to a branch the remote already has."
                : "This publishes the branch for the first time. Telar never force-pushes."}
            </span>
          </p>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setArmed(undefined)} disabled={working}>
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={() => void push()} disabled={working}>
              {working ? <Spinner className="size-3" /> : <ArrowUpFromLineIcon className="size-3" />}
              {working ? "Pushing…" : "Push"}
            </Button>
          </div>
        </div>
      ) : armed === "pull" ? (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Pull request title"
            autoFocus
            className="w-full rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            aria-label="Pull request description"
            placeholder="Description (optional)"
            className="w-full resize-none rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
          />
          <p className="text-2xs leading-snug text-muted-foreground">
            This happens on GitHub and cannot be undone from Telar. The description carries this session&rsquo;s id, so the conversation
            behind it is findable.
          </p>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setArmed(undefined)} disabled={working}>
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={() => void openPull()} disabled={working || !title.trim()}>
              {working ? <Spinner className="size-3" /> : <GitPullRequestArrowIcon className="size-3" />}
              {working ? "Opening…" : "Open pull request"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-2xs leading-snug text-muted-foreground">
            {!published
              ? `origin has never seen this branch${commitsSinceBase > 0 ? ` — ${commitsSinceBase} ${commitsSinceBase === 1 ? "commit" : "commits"} to publish` : ""}.`
              : ahead > 0
                ? `${ahead} ${ahead === 1 ? "commit" : "commits"} not on origin yet.`
                : "origin has every commit on this branch."}
          </p>
          {/* TWO ARMS ON ONE ROW, and the left one is available in states the
              right one is not. That is the whole shape of #670's answer. */}
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy || !pushable}
              title={busy ? "A turn is running — the agent may be mid-write" : undefined}
              onClick={() => {
                setPushProblem(undefined);
                setArmed("push");
              }}
            >
              <ArrowUpFromLineIcon className="size-3" />
              Push
            </Button>
            {/* ABSENT RATHER THAN DISABLED where gh has nothing to offer — a
                greyed-out button is a promise this machine cannot keep, and the
                reader has no way to find out why from here. Hidden once a pull
                request has been opened too: the link above is what is left to
                do with it. */}
            {github === true && !opened && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || !published}
                title={!published ? "Push the branch first — a pull request needs a branch the remote has" : undefined}
                onClick={() => {
                  setPullProblem(undefined);
                  setTitle(suggestion);
                  setArmed("pull");
                }}
              >
                <GitPullRequestArrowIcon className="size-3" />
                Pull request
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One refusal, in the grammar the merge footer already uses: the sentence, the
 *  detail underneath it, and a way to put it away. */
function PublishProblem({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div className="mb-2 flex items-start gap-2 text-2xs leading-snug">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        {children}
        <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
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
  tab,
  onTabChange,
  turns,
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
   * THIS INSTANCE, WHOLE — the scope it is looking at, the base and turn it
   * remembers, and its filter (#694, #335).
   *
   * IT LIVES IN THE TAB'S PARAMS, NOT IN THIS COMPONENT, which is what makes it
   * an instance rather than a mood: the strip reads the filter for the label
   * ("Diff · src/"), the panel persists the lot with the rest of the
   * arrangement, and a surface remounted by a session switch comes back looking
   * at the same thing. Local state here would be none of those things — and
   * because each panel holds its own `PanelTabState`, two windows on one
   * session keep their own scope, the same way #715's open issues do.
   *
   * ONE OBJECT RATHER THAN A FIELD PER PARAM, because `setPanelTabParams` is a
   * REPLACE: a handler writing `{ filter }` would erase the scope and one
   * writing `{ scope }` would erase the filter, and neither would look broken
   * until somebody typed in the filter field.
   */
  tab: DiffTab;
  /** Rewrite this instance. Absent hides every control that would write one,
   *  for a caller with no params to keep. */
  onTabChange?: (tab: DiffTab) => void;
  /** The turns that reported writing something, newest first — the `turn`
   *  scope's whole source. Empty on a canvas, which is why that scope is not
   *  offered there. */
  turns?: readonly DiffTurn[];
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
  /**
   * THE BASE IS THE SCOPE (#694). `unstaged` sends an EMPTY base — "compare
   * against nothing" — which is a different request from sending none, and
   * sending none is what every reader of this surface got before the selector
   * existed. `branch` sends the chosen ref, or none to mean the session's own.
   */
  /** The turn this tab is showing, and whether the one it named is still here.
   *  A named turn can genuinely go — the window slid past it — and falling back
   *  to the newest beats a surface that renders nothing and explains nothing. */
  const turn = useMemo(() => turnFor(turns ?? [], tab.turn), [turns, tab.turn]);

  /**
   * WHAT THIS TAB ASKS GIT FOR — or `undefined` when git cannot be asked.
   *
   * `undefined` IS ONLY EVER THE TURN SCOPE, and only a turn with no usable
   * anchor: one that ran before #741, one whose probe never answered, one in a
   * repository with no commits. Those keep the journal witness they always had.
   * An ANCHORED turn is a range, and everything below routes to git for it —
   * which is what #741 is.
   */
  const base = diffBaseFor(tab, turn?.anchor);
  /** Whether this tab's answer comes from git at all. One decision, read by the
   *  patch reader, the review fold and the framing, so the three cannot drift
   *  into describing different witnesses. */
  const fromGit = base !== undefined;
  const load = useCallback(async () => {
    try {
      // AN UNANCHORED TURN MAKES NO GIT READ AT ALL, so the list it draws stays
      // the journal's — see `diffBaseFor`. Reading the session's own base here
      // would put a whole-session file list under a heading naming one turn.
      if (sessionId) setDiff((await api.sessionDiff(sessionId, base ?? {})).diff);
      // A CANVAS HAS NO BASE TO OVERRIDE. Its project read is already
      // `HEAD…worktree` — the `unstaged` question — so there is nothing for a
      // scope to change and nothing to send.
      else if (projectId) setDiff((await api.projectDiff(projectId)).diff);
      else return;
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
    // `base` is rebuilt each render; its CONTENTS are what matter to the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId, base?.base, base?.to]);


  /**
   * THE BASES, READ ONLY WHEN SOMEBODY IS CHOOSING ONE.
   *
   * Not threaded down from the panel like the turns are, because the two are
   * different kinds of thing: the turns are a fold of a journal the panel
   * already holds, and this is a SUBPROCESS — `git for-each-ref` in the
   * project's checkout. Fetching it on every mount would put a git read behind
   * every Diff tab anybody opens, for a menu most of them never touch.
   *
   * ONCE, AND NOT ON A TIMER. Refs move when somebody branches or fetches,
   * which is not something this surface should be discovering every fifteen
   * seconds — and the picker is re-read on the next scope change anyway.
   */
  const [refs, setRefs] = useState<readonly GitRefEntry[]>();
  useEffect(() => {
    if (tab.kind !== "branch" || refs !== undefined || !projectId) return;
    let cancelled = false;
    void api
      .projectGit(projectId)
      .then((answer) => {
        if (!cancelled) setRefs(answer.git.refs ?? []);
      })
      .catch(() => {
        // The picker keeps its "where this session started" row and says
        // nothing about refs, which is the honest smaller menu.
        if (!cancelled) setRefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab.kind, refs, projectId]);

  /**
   * WHETHER `gh` HAS ANYTHING TO OFFER FOR THIS PROJECT (#670), read ONCE and
   * NOT ON A TIMER — the same shape and the same reasoning as the ref read
   * above, and owned here for the same reason: it is a SUBPROCESS, and putting
   * a `gh` round trip behind every Diff tab anybody opens would be a network
   * call for a button most of them never press. Whether this checkout is on
   * GitHub does not change every fifteen seconds.
   *
   * ASKED ONLY WHERE THE ARM COULD EXIST. A canvas has no session to publish
   * and a `local` session has no branch of its own, so neither asks — and the
   * engine caches the answer per project, so a reader who has had the forge
   * panel open pays nothing for it.
   */
  const [github, setGithub] = useState<boolean>();
  const publishable = Boolean(sessionId) && diff?.shared !== true && Boolean(diff?.branch);
  useEffect(() => {
    if (!publishable || !projectId || github !== undefined) return;
    let cancelled = false;
    void api
      .projectGitHub(projectId)
      .then((answer) => {
        if (!cancelled) setGithub(answer.github.unavailable === undefined);
      })
      .catch(() => {
        // A read that failed is not evidence that `gh` works, and the arm it
        // would enable is the outward-facing one. Absent is the honest answer.
        if (!cancelled) setGithub(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publishable, projectId, github]);

  /**
   * IGNORING WHITESPACE IS PART OF THE REQUEST, not part of the rendering
   * (#694) — git decides which hunks exist. So the toggle is in this callback's
   * dependencies, and an open row re-reads when it flips: see the effect in
   * `ReviewFileRow` that watches this function's identity. The BASE is in them
   * for the same reason: a row's patch read against a different base from the
   * list above it would put plausible hunks under wrong counts.
   *
   * THE TURN SCOPE NEVER ASKS GIT. Its patch is the one the agent's own tool
   * reported, already in hand — so this resolves it rather than fetching, and
   * a path the tool wrote without producing a patch says so through the same
   * `incomplete` channel a git failure uses, because "there is no patch for
   * this" is the same fact either way.
   */
  const readPatch = useCallback(
    (file: GitFileChange): Promise<{ file: GitFilePatch }> => {
      if (tab.kind === "turn" && !fromGit) {
        const reported = turn?.patches.get(file.path);
        return Promise.resolve({
          file: reported
            ? // A JOURNAL PATCH CUT AT ITS BOUND USES THE SAME CHANNEL a git
              // one does (#694, §2.5). "This is not the whole patch" is one
              // fact about a read, however the read was made — and it used to
              // be a sentence INSIDE the patch, which the renderer drops.
              { patch: reported.patch, binary: false, ...(reported.truncated ? { incomplete: "truncated" as const } : {}) }
            : { patch: "", binary: false, incomplete: "failed" as const },
        });
      }
      const options = patchRequestFor(file, view, base ?? {});
      return sessionId ? api.sessionFilePatch(sessionId, file.path, options) : api.projectFilePatch(projectId!, file.path, options);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, projectId, view.ignoreWhitespace, base?.base, base?.to, fromGit, tab.kind, turn],
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

  /**
   * THE REVIEW THE ROWS COME FROM — git's, or the turn's.
   *
   * THE TWO ARE DIFFERENT WITNESSES AND THIS IS THE SEAM BETWEEN THEM. For
   * `unstaged` and `branch` it is `reconcileReview`: git's file list, joined
   * against the journal so the rows nobody narrated are called out. For `turn`
   * it is the journal ALONE — the agent's reported writes, with its own
   * reported patches — and there is nothing to reconcile, because the journal
   * cannot disagree with itself. Every row is `reported: true` for that reason,
   * not as a convenience: the question "did the transcript mention this" has
   * one answer in a list built from the transcript.
   *
   * `linesAdded`/`linesRemoved` ARE THE TURN'S OWN, so the headline above the
   * rows counts the same things the rows do.
   *
   * ── AND SINCE #741 THE TURN SCOPE CAN BE GIT'S TOO ──────────────────────────
   *
   * An ANCHORED turn is a range of commits, so its list comes back from
   * `sessionDiff` like any other and gets `reconcileReview` like any other —
   * which is the point: the journal's account and git's can now DISAGREE inside
   * the turn scope, and the disagreement is the thing worth seeing. An
   * unanchored turn keeps the fold below, because for it the journal is still
   * the only witness there is.
   */
  const review = useMemo(() => {
    if (tab.kind === "turn" && !fromGit) {
      if (!turn) return { rows: [], unreported: [], settled: [], filesChanged: 0, linesAdded: 0, linesRemoved: 0 } satisfies SessionReview;
      return {
        rows: turn.files.map((file) => ({ file, reported: true })),
        unreported: [],
        settled: [],
        filesChanged: turn.files.length,
        linesAdded: turn.files.reduce((total, file) => total + (file.linesAdded ?? 0), 0),
        linesRemoved: turn.files.reduce((total, file) => total + (file.linesRemoved ?? 0), 0),
      } satisfies SessionReview;
    }
    return diff ? reconcileReview(diff, reported) : undefined;
  }, [tab.kind, fromGit, turn, diff, reported]);
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
  const shown = useMemo(() => (review ? reviewUnderFilter(review, tab.filter) : undefined), [review, tab.filter]);
  /** The filter as it MEANS rather than as the field holds it — whitespace
   *  alone is not a filter, and neither is an empty string. Shown as typed
   *  otherwise, so the prose below and the tab's own label agree. */
  const trimmed = tab.filter?.trim() || undefined;

  /** Built once and spread onto both row lists, so the two can never drift
   *  into offering different menus for the same kind of row. */
  const rowMenu = { ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {}), ...(onInsertReference ? { onInsertReference } : {}) };
  /** Which party a row may name when it has no patch to draw (#694). Decided
   *  once here, beside `readPatch`, because the two answer the same question
   *  from the same place. */
  const witness: PatchWitness = tab.kind === "turn" ? "journal" : "git";

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
  /**
   * THE TURN SCOPE IS A DIFFERENT WITNESS AND THE SURFACE SAYS SO — #694.
   *
   * `reviewFraming` speaks for git: whose changes these are, and how much of
   * them git managed to report. Neither question applies to a list built from
   * the transcript, and answering them anyway would be #690's defect committed
   * a second time — a sentence that is true of one mode stated over another.
   * So the turn scope supplies its own pair, and the word doing the work is
   * "reported": the patches below are the ones the agent's tool produced, which
   * is not the same as what is on disk, and this is the only place a reader
   * would find that out.
   */
  const turnFraming = tab.kind === "turn" && turn ? { headline: `${describeReview(shown)} — ${turnLabel(turn)}`, note: turnNote(turn, diff) } : undefined;

  return (
    <div className="flex min-h-full flex-col">
      {/* THE HEADLINE ANSWERS THE QUESTION IN ONE LINE: how far back the
          comparison reaches, and how big the answer is. */}
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-2 text-2xs">
          <DiffScopePicker
            tab={tab}
            {...(onTabChange ? { onTabChange } : {})}
            hasSession={Boolean(sessionId)}
            {...(refs ? { refs } : {})}
            {...(turns ? { turns } : {})}
            sessionBase={diff.base}
          />
          {diff.branch && tab.kind !== "turn" && (
            <>
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
        <p className={cn("mt-1 text-sm font-medium tabular-nums", fromGit && diff.filesIncomplete && "text-warning")}>
          {turnFraming?.headline ?? framing.headline}
          {/* A GIT DOUBT, so it is silent over a list git did not produce. */}
          {fromGit && diff.filesIncomplete && <span className="ml-1.5 text-2xs font-normal">· incomplete</span>}
        </p>
        <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
          {/* WHICH QUESTION THESE FIGURES ANSWER — `reviewFraming`. Without a
              base it is a smaller question; over a read git cut short it is "as
              much as git reported" rather than "everything" (#654); and on a
              SHARED checkout it is a question about the checkout rather than
              about this session (#690), so the sentence says so instead of
              claiming work the session may never have done. The TURN scope
              answers none of those questions and says which witness it is
              instead (#694). */}
          {turnFraming?.note ?? framing.note}
          {/* THE FILTER IS SAID OUT LOUD, because the figure above it is a
              count of a SUBSET and everything else on this line describes the
              whole. A tab you came back to an hour later has to be able to
              explain why it disagrees with the one beside it. */}
          {trimmed ? ` Filtered to ${trimmed} — ${review.filesChanged} ${review.filesChanged === 1 ? "file" : "files"} in all.` : ""}
          {/* Both are facts about the git read, so both go quiet over a turn. */}
          {fromGit && tab.kind !== "turn" && diff.ahead !== undefined && diff.ahead > 0 ? ` ${diff.ahead} ahead of upstream.` : ""}
          {fromGit && diff.truncated ? " The list below is capped; the figures above are not." : ""}
        </p>
        {/* THE FIELD IS THE INSTANCE'S IDENTITY, so it sits in the header where
            a tab's subject belongs — beside the branch it is a review of, not
            buried in a menu. Typing writes straight through to the tab's
            params: there is no local copy to fall out of step with the label,
            and clearing the field clears the param. */}
        {onTabChange && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 focus-within:border-ring">
            <ListFilterIcon className="size-3 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={tab.filter ?? ""}
              /* THROUGH THE WHOLE TAB, never `{ filter }` alone: params are a
                 REPLACE, so a partial write here would silently reset the scope
                 and the base this reader chose two clicks ago. */
              onChange={(event) => onTabChange({ ...tab, filter: event.target.value })}
              placeholder="Filter by folder or file"
              aria-label="Filter this review by path"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-2xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
            />
            {tab.filter && (
              <button
                type="button"
                aria-label="Clear the filter"
                title="Clear the filter"
                onClick={() => onTabChange({ ...tab, filter: "" })}
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

      {/* EVERY BAND BELOW REPORTS ON THE GIT READ, so all three go quiet over a
          turn (#694): what git failed to answer, where the transcript and the
          disk disagree, and which commits the session made are three facts
          about a comparison this scope did not make. Showing them would attach
          git's doubts to the journal's list — the exact conflation #690 was
          about, in the other direction. */}
      {/* THE BANDS REPORT ON A GIT READ, so they follow the READ rather than the
          scope (#741). An anchored turn IS a git read — `git diff before after`
          — so what git failed to answer and where the transcript disagrees with
          the disk are live questions for it, and they come back. An unanchored
          one makes no git read at all, and attaching git's doubts to a journal
          list would be #690 inverted: a true statement about the wrong subject. */}
      {fromGit && (
        <>
          {/* FIRST OF THE BANDS, because it is the only one that can make
              everything under it untrustworthy — including the other band's
              own figures. */}
          <DiffUnknownBand diff={diff} onRetry={load} />
          {/* The reconciliation needs a TRANSCRIPT to disagree with. A canvas
              has none, so the band would be reporting every file as "never
              mentioned" by a session that has not said anything yet — and a
              shared checkout has one that cannot speak for the tree (#690,
              `framing.journal`). */}
          {sessionId && <ReconciliationBand review={shown} journal={framing.journal} />}
          <CommitList commits={diff.commits} />
        </>
      )}

      {shown.rows.length === 0 ? (
        turnFraming ? (
          <div className="px-4 py-6 text-center text-2xs text-muted-foreground">
            {/* THREE DIFFERENT EMPTIES, and only the first is about this turn:
                a turn that read and reasoned and wrote nothing is ordinary, a
                filter that matches none of its files is not a claim about the
                turn, and a session that has not written anything yet has no
                turn to show. */}
            {turns && turns.length === 0
              ? "No turn in this conversation has reported writing a file yet."
              : trimmed
                ? `This turn reported nothing under ${trimmed}.`
                : "This turn reported writing nothing."}
          </div>
        ) : (
          <ReviewEmptyState review={review} trimmed={trimmed} filesIncomplete={diff.filesIncomplete} />
        )
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
                witness={witness}
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
                witness={witness}
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
          <>
          {/* `review`, NOT `shown`: the commit takes the whole tree, so the
             count on the button is the whole tree's even when the list above
             is filtered. See the note on `shown`. */}
          <CommitBox
          sessionId={sessionId}
          suggestion={suggestion}
          files={review.filesChanged}
          {...(diff.filesIncomplete ? { countIncomplete: true } : {})}
          busy={active === "running" || active === "claimed"}
          workspacePath={diff.workspacePath}
          onCommitted={() => void load()}
          />
          {/* PUBLISHING IS FOR A SESSION'S OWN BRANCH AND NOTHING ELSE (#670).
              `shared` is the engine's own word for a `local` session, which
              works in the PROJECT's checkout beside the user's editor — there
              is no session branch there to publish, and the engine refuses it
              with `local_checkout` if anything asks anyway. The `turn` scope is
              a different witness entirely (see `turnFraming`), and its figures
              are the agent's reported patches rather than the repository's, so
              a publish region reading them would be counting the wrong thing. */}
          {diff.branch && diff.shared !== true && tab.kind !== "turn" && (
            <PublishBox
              sendPush={() => api.pushSessionBranch(sessionId)}
              sendPullRequest={(input) => api.openSessionPullRequest(sessionId, input)}
              {...(github === undefined ? {} : { github })}
              branch={diff.branch}
              {...(diff.ahead === undefined ? {} : { ahead: diff.ahead })}
              commitsSinceBase={diff.commits.length}
              busy={active === "running" || active === "claimed"}
              suggestion={suggestion}
              onPublished={() => void load()}
            />
          )}
          </>
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
