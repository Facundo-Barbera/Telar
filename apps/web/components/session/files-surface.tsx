"use client";

/**
 * THE FILES SURFACE — the checkout, as a tree.
 *
 * WHY THIS REPLACED THE GIT TAB. There were two tabs listing changed files with
 * their diffs, which is one tab; and there was nowhere at all to see the files
 * that did NOT change, which is most of them. So the pair became "Diff" and this
 * became "Files": one surface for what moved, one for what is there.
 *
 * MODELLED ON t3 code's file browser, down to the four decisions that make a
 * monorepo tree usable — refresh and search in a thin subheader, single-child
 * directory chains collapsed into one row, one level open on arrival, and a
 * search that HIDES non-matches instead of highlighting them. The tree logic is
 * in lib/file-tree.ts, pure and pinned; this file is the chrome, the keyboard and
 * the reads.
 *
 * WHAT IS OURS RATHER THAN BORROWED:
 *
 *   - GIT STATUS ON THE ROWS, and on the collapsed directories above them. In a
 *     tool where an AGENT does the writing, "what has been touched in here" is
 *     the first question a tree gets asked, and it is the one thing a plain file
 *     browser cannot answer. It comes from the same diff read the Diff tab makes.
 *   - EVERY ROW IS A DRAG HANDLE, into the message you are writing — the same
 *     gesture as an issue or a page, through the same `lib/drag-reference`. A
 *     directory keeps its trailing slash so an agent knows it is one.
 *   - MONOSPACE, at the same 11px as the Diff surface's rows. t3's tree is 12px
 *     sans; matching our own neighbouring tab matters more than matching the
 *     donor, because these two tabs sit one click apart.
 *
 * IT DOES NOT POLL. The listing is git reading an index it already has — 18ms for
 * this repository — but a tree that reorders itself under the cursor every
 * fifteen seconds is hostile in a way a stale figure is not. There is a refresh
 * button, and it re-reads when a turn settles.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderTreeIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import type { GitChangeStatus, TurnState, WorkspaceListing } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { ancestorsOf, buildFileTree, directoryPaths, flattenTree, matchFiles, type FileTreeNode } from "@/lib/file-tree";
import { directoryReference, fileReference, startReferenceDrag } from "@/lib/drag-reference";
import type { OpenIntent } from "@/lib/editor-workspace";
import { REVIEW_STATUS_LETTER } from "@/lib/session-review";
import { EDITOR_HEADER_ROW } from "@/components/session/editor-chrome";
import { FileKindIcon } from "@/components/session/file-icon";
import { PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** The same five-colour vocabulary the Diff surface uses, so a modified file
 *  looks the same in both tabs. */
const STATUS_TONE: Record<GitChangeStatus, PanelTone> = {
  added: "done",
  untracked: "attention",
  modified: "none",
  deleted: "danger",
  renamed: "none",
};

/** One nesting level, in pixels. Small on purpose: a 320px panel showing a
 *  six-deep path cannot afford 16px a level, and the collapse rule means most
 *  trees are three or four deep rather than eight. */
const INDENT = 10;

type Row = { node: FileTreeNode; depth: number };

function FileTreeRow({
  row,
  expanded,
  focused,
  open,
  status,
  dirtyInside,
  onToggle,
  onOpen,
  onKeep,
  onFocus,
  register,
}: {
  row: Row;
  expanded: boolean;
  focused: boolean;
  /** This file already has a tab open in this panel. */
  open: boolean;
  status?: GitChangeStatus;
  /** A directory with something changed inside it, at any depth. */
  dirtyInside?: boolean;
  onToggle: () => void;
  /** A single click. In the Editor this is a PREVIEW — see the intent argument
   *  on `onOpenFile`. */
  onOpen: () => void;
  /** A double click, which means "keep this one". */
  onKeep: () => void;
  onFocus: () => void;
  register: (element: HTMLButtonElement | null) => void;
}) {
  const directory = row.node.kind === "directory";
  const Folder = expanded ? FolderOpenIcon : FolderIcon;
  return (
    /* Draggable on the WRAPPER, not the button — a draggable <button> fights its
       own click on every browser that has ever shipped. Same note as the Diff
       surface's rows. */
    <div
      draggable
      onDragStart={(event) =>
        startReferenceDrag(event.dataTransfer, directory ? directoryReference(row.node.path) : fileReference(row.node.path))
      }
    >
      <PanelRow tone={status ? STATUS_TONE[status] : "none"} className="p-0 pl-0">
        <button
          type="button"
          role="treeitem"
          aria-level={row.depth + 1}
          // SELECTED MEANS "OPEN IN A TAB", which is the only kind of selection
          // this tree has — clicking a file opens it, and there is no second
          // gesture that would mean something else. A directory reports `false`
          // rather than nothing: the role requires the attribute, and omitting it
          // on half the rows tells a screen reader the tree is inconsistent.
          aria-selected={directory ? false : open}
          {...(directory ? { "aria-expanded": expanded } : {})}
          // ROVING TABINDEX: one stop for the whole tree. A thousand files each
          // taking a Tab press is not a keyboard-accessible tree, it is a trap.
          tabIndex={focused ? 0 : -1}
          ref={register}
          onFocus={onFocus}
          onClick={directory ? onToggle : onOpen}
          /**
           * DOUBLE CLICK KEEPS THE FILE. The browser fires `click` first and
           * `dblclick` after, so this always lands on a file the single click
           * has already previewed — which is exactly the promotion the Editor's
           * preview slot is built around, not a second open.
           */
          {...(directory ? {} : { onDoubleClick: onKeep })}
          title={row.node.path}
          style={{ paddingLeft: 6 + row.depth * INDENT }}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-1 pr-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60",
            open && "bg-muted/40",
          )}
        >
          {/* The chevron's slot is reserved for files too, so names line up
              within a level instead of shifting by 12px per row kind. */}
          <span className="flex size-3 shrink-0 items-center justify-center">
            {directory && <ChevronRightIcon className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
          </span>
          {/* A DIRECTORY IS A FOLDER; A FILE IS WHAT IT IS. The folder keeps the
              panel's own colours because a directory has no language — the one
              exception is the warning tint, which is state and outranks it. A
              file gets its kind's glyph and tint (lib/file-kinds.ts), which is
              what makes the tree scannable rather than a column of identical
              sheets. */}
          {directory ? (
            <Folder className={cn("size-3.5 shrink-0", dirtyInside ? "text-warning" : "text-muted-foreground")} />
          ) : (
            <FileKindIcon path={row.node.path} className="size-3.5" />
          )}
          <span className={cn("min-w-0 flex-1 truncate font-mono text-[0.6875rem]", directory ? "text-foreground" : "text-muted-foreground")}>
            {row.node.name}
          </span>
          {/* Git's own letter, same as the Diff rows — no legend needed. */}
          {status && <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">{REVIEW_STATUS_LETTER[status]}</span>}
          {/* A collapsed directory says something inside it moved. Without this
              the tint is invisible until you have already found the file. */}
          {!status && dirtyInside && !expanded && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning/70" />}
        </button>
      </PanelRow>
    </div>
  );
}

export function FilesSurface({
  sessionId,
  projectId,
  /** Paths this panel already has open as tabs, so the tree can say so. */
  openPaths = [],
  onOpenFile,
  /** A turn settling is the moment the tree has actually changed. */
  active,
}: {
  sessionId?: string;
  projectId?: string;
  openPaths?: readonly string[];
  /**
   * Open a file, and say how deliberately.
   *
   * `preview` is a single click — browsing. `pin` is a double click or the
   * keyboard's Enter, which is a person naming the file they came for. The tree
   * does not know what the caller does with that (the Editor borrows one
   * reusable slot for a preview; everything else ignores the argument), it only
   * reports which gesture happened.
   */
  onOpenFile: (path: string, intent: OpenIntent) => void;
  active?: TurnState;
}) {
  const [listing, setListing] = useState<WorkspaceListing>();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitChangeStatus>>(new Map());
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  /** What a person opened, outside a search. Nothing, on arrival: "one level" for
   *  a rootless tree means the top-level rows and no more. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  /** What a person shut WHILE SEARCHING, where the default is the opposite. Two
   *  sets because they mean opposite things; one set would silently re-open a
   *  directory the moment a search cleared. Discarded when the query changes. */
  const [shutWhileSearching, setShutWhileSearching] = useState<ReadonlySet<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string>();
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    const listFiles = () => (sessionId ? api.sessionFiles(sessionId) : api.projectFiles(projectId!));
    const readDiff = () => (sessionId ? api.sessionDiff(sessionId) : api.projectDiff(projectId!));
    try {
      /**
       * BOTH READS AT ONCE, and the diff is allowed to fail on its own. The tree
       * is the point; the status letters are an annotation, and a checkout that
       * cannot produce a diff should still be browsable.
       */
      const [listed, diff] = await Promise.all([listFiles(), readDiff().catch(() => undefined)]);
      setListing(listed.listing);
      setStatuses(new Map((diff?.diff.files ?? []).map((file) => [file.path, file.status])));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body, matching the
    // rest of the app: a synchronous fetch-and-setState on mount is a cascading
    // render. `load` returns early when there is no checkout to read.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  const searched = useMemo(() => matchFiles(listing?.files ?? [], query), [listing, query]);
  const tree = useMemo(() => buildFileTree(searched.files), [searched.files]);
  /**
   * A SEARCH EXPANDS EVERYTHING, because a filtered tree is small and hiding its
   * matches behind chevrons is the one thing a search must not do. Outside a
   * search the default is "one level", which for a rootless tree means nothing
   * expanded — and a person's own clicks are layered on top of that in two sets:
   * what they opened, and what they shut. Storing only "expanded" would silently
   * re-open a directory the moment a search cleared.
   */
  const searching = query.trim().length > 0;
  const expanded = useMemo(
    () => (searching ? new Set(directoryPaths(tree).filter((path) => !shutWhileSearching.has(path))) : opened),
    [searching, tree, shutWhileSearching, opened],
  );
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const dirty = useMemo(() => ancestorsOf(statuses.keys()), [statuses]);
  const openTabs = useMemo(() => new Set(openPaths), [openPaths]);

  /** Flip membership. The set it flips in depends on which default is in force —
   *  see the two pieces of state above. */
  const toggle = useCallback(
    (path: string) => {
      const flip = (current: ReadonlySet<string>) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      };
      if (searching) setShutWhileSearching(flip);
      else setOpened(flip);
    },
    [searching],
  );

  const focusRow = useCallback((path: string | undefined) => {
    if (path === undefined) return;
    setFocusedPath(path);
    rowsRef.current.get(path)?.focus();
  }, []);

  /**
   * The keyboard a tree is expected to have.
   *
   * Up and down move between adjacent VISIBLE rows regardless of nesting, which
   * is why `rows` is flat. Right opens a shut directory and steps into an open
   * one; left shuts an open one and steps out of a leaf. That pair is what makes
   * a tree navigable without the mouse, and it is the whole reason this is not a
   * list of nested `<div>`s with click handlers.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.node.path === focusedPath);
    const row = rows[index];
    const step = (delta: number) => {
      event.preventDefault();
      focusRow(rows[Math.min(Math.max(index + delta, 0), rows.length - 1)]?.node.path);
    };
    if (event.key === "ArrowDown") return step(index === -1 ? 0 : 1);
    if (event.key === "ArrowUp") return step(-1);
    if (event.key === "Home") {
      event.preventDefault();
      return focusRow(rows[0]?.node.path);
    }
    if (event.key === "End") {
      event.preventDefault();
      return focusRow(rows[rows.length - 1]?.node.path);
    }
    if (!row) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.node.kind !== "directory") return;
      if (expanded.has(row.node.path)) return focusRow(rows[index + 1]?.node.path);
      return toggle(row.node.path);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.kind === "directory" && expanded.has(row.node.path)) return toggle(row.node.path);
      // Out to the parent: the nearest row above at a shallower depth.
      for (let above = index - 1; above >= 0; above -= 1) {
        if (rows[above]!.depth < row.depth) return focusRow(rows[above]!.node.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.node.kind === "directory") return toggle(row.node.path);
      // Enter is deliberate in a way a click is not: you arrowed to this row and
      // pressed a key to open it, which is the keyboard's double click.
      return onOpenFile(row.node.path, "pin");
    }
  };

  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<FolderTreeIcon />} title="No project">
        No checkout to list yet.
      </PanelEmpty>
    );
  }
  if (error) {
    return (
      <PanelEmpty icon={<FolderTreeIcon />} title="Could not read the checkout">
        {error}
      </PanelEmpty>
    );
  }

  return (
    /* FULL HEIGHT, THREE BANDS: a fixed header, ONE scrolling row list, a fixed
       foot. The scroller used to be the box around this surface, which took the
       header with it — see the note in session/editor-surface.tsx. */
    <div className="flex h-full min-h-0 flex-col">
      {/* THE SUBHEADER, from t3 code: refresh and search on one thin line.
          It wears `EDITOR_HEADER_ROW` — the SAME string as the Editor's
          open-file strip on the other side of the `border-r`, which is the
          whole point: this header used to size itself around the 28px search
          box and came out 4px taller than the strip, and the step showed at the
          seam. Sized now, with the box centred inside it. */}
      <div className={cn(EDITOR_HEADER_ROW, "gap-1")}>
        <button
          type="button"
          aria-label="Refresh the file list"
          title={refreshing ? "Refreshing…" : "Refresh files"}
          onClick={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RotateCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted/50 px-2 focus-within:bg-muted">
          <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
          <input
            type="search"
            name="workspace-file-search"
            value={query}
            aria-label="Search files"
            placeholder="Search files"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              // A new query is a new set of matches, so what was shut under the
              // previous one no longer refers to anything a reader chose.
              setShutWhileSearching(new Set());
            }}
            // Escape clears rather than blurring, the same as t3's: the search is
            // a filter over what you are looking at, and the way out of a filter
            // is to remove it.
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setQuery("");
              setShutWhileSearching(new Set());
            }}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      {/* THE ONE SCROLLING BAND. The rows and every state that stands in for
          them live in here, so the header above stays put. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!listing ? (
          <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground">
            <Spinner className="size-3" /> reading the checkout…
          </p>
        ) : rows.length === 0 ? (
          <PanelEmpty icon={<FolderTreeIcon />} title={searching ? "Nothing matches" : "This checkout is empty"}>
            {searching
              ? `No path in this checkout contains “${query.trim()}”.`
              : listing.repository
                ? "git lists no files here — every path is ignored."
                : "There are no files in this directory."}
          </PanelEmpty>
        ) : (
          <div role="tree" aria-label="Workspace files" onKeyDown={onKeyDown} className="flex flex-col py-0.5">
            {rows.map((row) => (
              <FileTreeRow
                key={row.node.path}
                row={row}
                expanded={expanded.has(row.node.path)}
                // One tab stop, and it lands on the row you last touched — or the
                // first row, so a fresh tree is reachable at all.
                focused={focusedPath === undefined ? row === rows[0] : focusedPath === row.node.path}
                open={openTabs.has(row.node.path)}
                {...(statuses.get(row.node.path) ? { status: statuses.get(row.node.path)! } : {})}
                {...(row.node.kind === "directory" && dirty.has(row.node.path) ? { dirtyInside: true } : {})}
                onToggle={() => toggle(row.node.path)}
                onOpen={() => onOpenFile(row.node.path, "preview")}
                onKeep={() => onOpenFile(row.node.path, "pin")}
                onFocus={() => setFocusedPath(row.node.path)}
                register={(element) => {
                  if (element) rowsRef.current.set(row.node.path, element);
                  else rowsRef.current.delete(row.node.path);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* THE FOOT SAYS WHAT THE LIST IS, and every way it might not be all of
          it. A tree that quietly stops at 400 rows reads as a small repository.
          It sits below the scroller rather than at the end of it, so a long tree
          cannot scroll the count away. */}
      {listing && (
        <p className="shrink-0 border-t border-border px-3 py-2 text-[0.6875rem] leading-snug text-muted-foreground">
          {searching
            ? `${searched.matches.toLocaleString("en-US")} of ${listing.files.length.toLocaleString("en-US")} paths match${
                searched.truncated ? `, showing the first ${searched.files.length}` : ""
              }.`
            : `${listing.files.length.toLocaleString("en-US")} files${listing.truncated ? " (capped)" : ""} · ${
                listing.repository ? "tracked and unignored, from git" : "walked — this directory is not a repository"
              }`}
        </p>
      )}
    </div>
  );
}
