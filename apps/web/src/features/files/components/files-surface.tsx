"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderTreeIcon, HardDriveIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import type { GitChangeStatus, TurnState, WorkspaceListing } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { ancestorsOf, buildFileTree, directoryPaths, flattenTree, matchFiles, type FileTreeNode } from "../file-tree";
import { directoryReference, fileReference, startReferenceDrag, type TelarReference } from "@/features/composer";
import type { OpenIntent } from "../editor-workspace";
import { REVIEW_STATUS_LETTER, REVIEW_STATUS_WORD } from "@/features/git";
import { useWorkspaceFileMenu, workspaceFilePath, type WorkspaceFileMenu } from "../workspace-open";
import { EDITOR_HEADER_ROW } from "./editor-chrome";
import { FileKindIcon } from "./file-icon";
import { OpenerIcon } from "./opener-icon";
import { PanelEmpty, PanelRow } from "@/ui/panel";
import { Spinner } from "@/ui/spinner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { cn } from "@/ui/utils";

const api = createEngineApi();

const INDENT = 10;

type Row = { node: FileTreeNode; depth: number };

export function FileRowMenuItems({
  path,
  directory,
  expanded,
  absolute,
  files,
  onOpen,
  onKeep,
  onToggle,
  onCollapseAll,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  path: string;
  directory: boolean;
  expanded: boolean;
  absolute?: string | undefined;
  files: WorkspaceFileMenu;
  onOpen: () => void;
  onKeep: () => void;
  onToggle: () => void;
  onCollapseAll: () => void;
  onInsertReference?: ((reference: TelarReference) => void) | undefined;
  onOpenInNewPanelTab?: ((path: string) => void) | undefined;
}) {
  const kind = directory ? "directory" : "file";
  return (
    <>
      {directory ? (
        <>
          <ContextMenuItem onClick={onToggle}>{expanded ? "Collapse" : "Expand"}</ContextMenuItem>
          <ContextMenuItem onClick={onCollapseAll}>Collapse all</ContextMenuItem>
        </>
      ) : (
        <>
          <ContextMenuItem onClick={onOpen}>Open</ContextMenuItem>
          <ContextMenuItem onClick={onKeep}>Open pinned</ContextMenuItem>
          {onOpenInNewPanelTab && (
            <ContextMenuItem onClick={() => onOpenInNewPanelTab(path)}>Open in a new panel tab</ContextMenuItem>
          )}
        </>
      )}
      {files.reveal && files.open && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => files.reveal!(path, kind)}>Reveal in Finder</ContextMenuItem>
          <ContextMenuItem onClick={() => files.open!(path, kind)}>
            <OpenerIcon icon={files.openIcon} iconDataUrl={files.openIconDataUrl} />
            {files.openLabel}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      {absolute && <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute)}>Copy path</ContextMenuItem>}
      <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>
      {onInsertReference && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onInsertReference(directory ? directoryReference(path) : fileReference(path))}>
            Insert into composer as a reference
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

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
  absolute,
  files,
  onCollapseAll,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  row: Row;
  expanded: boolean;
  focused: boolean;
  open: boolean;
  status?: GitChangeStatus;
  dirtyInside?: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onKeep: () => void;
  onFocus: () => void;
  register: (element: HTMLButtonElement | null) => void;
  absolute?: string | undefined;
  files: WorkspaceFileMenu;
  onCollapseAll: () => void;
  onInsertReference?: ((reference: TelarReference) => void) | undefined;
  onOpenInNewPanelTab?: ((path: string) => void) | undefined;
}) {
  const directory = row.node.kind === "directory";
  const Folder = expanded ? FolderOpenIcon : FolderIcon;
  return (
    <div
      draggable
      onDragStart={(event) =>
        startReferenceDrag(event.dataTransfer, directory ? directoryReference(row.node.path) : fileReference(row.node.path))
      }
    >
      <ContextMenu>
        <ContextMenuTrigger>
          <PanelRow className="p-0 pl-0">
            <button
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={directory ? false : open}
              {...(directory ? { "aria-expanded": expanded } : {})}
              tabIndex={focused ? 0 : -1}
              ref={register}
              onFocus={onFocus}
              onClick={directory ? onToggle : onOpen}
              {...(directory ? {} : { onDoubleClick: onKeep })}
              title={row.node.path}
              style={{ paddingLeft: 6 + row.depth * INDENT }}
              className={cn(
                "flex h-6 w-full min-w-0 items-center gap-1 pr-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60",
                open && "bg-muted/40",
              )}
            >
              <span className="flex size-3 shrink-0 items-center justify-center">
                {directory && <ChevronRightIcon className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
              </span>
              {directory ? (
                <Folder className={cn("size-3.5 shrink-0", dirtyInside ? "text-warning" : "text-muted-foreground")} />
              ) : (
                <FileKindIcon path={row.node.path} className="size-3.5" />
              )}
              <span className={cn("min-w-0 flex-1 truncate font-mono text-2xs", directory ? "text-foreground" : "text-muted-foreground")}>
                {row.node.name}
              </span>
              {status && (
                <span className="shrink-0 font-mono text-3xs text-muted-foreground" title={REVIEW_STATUS_WORD[status]}>
                  {REVIEW_STATUS_LETTER[status]}
                </span>
              )}
              {!status && dirtyInside && !expanded && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning/70" />}
            </button>
          </PanelRow>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FileRowMenuItems
            path={row.node.path}
            directory={directory}
            expanded={expanded}
            {...(absolute ? { absolute } : {})}
            files={files}
            onOpen={onOpen}
            onKeep={onKeep}
            onToggle={onToggle}
            onCollapseAll={onCollapseAll}
            {...(onInsertReference ? { onInsertReference } : {})}
            {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
          />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

export function FilesSurface({
  sessionId,
  projectId,
  hostId,
  openPaths = [],
  onOpenFile,
  onWorkspacePath,
  onInsertReference,
  onOpenInNewPanelTab,
  reveal,
  active,
}: {
  sessionId?: string;
  projectId?: string;
  hostId?: string;
  openPaths?: readonly string[];
  onOpenFile: (path: string, intent: OpenIntent) => void;
  onWorkspacePath?: (path: string) => void;
  onInsertReference?: (reference: TelarReference) => void;
  onOpenInNewPanelTab?: (path: string) => void;
  reveal?: { path: string; nonce: number };
  active?: TurnState;
}) {
  const [listing, setListing] = useState<WorkspaceListing>();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitChangeStatus>>(new Map());
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [shutWhileSearching, setShutWhileSearching] = useState<ReadonlySet<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string>();
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    const listFiles = () => (sessionId ? api.sessionFiles(sessionId) : api.projectFiles(projectId!));
    const readDiff = () => (sessionId ? api.sessionDiff(sessionId) : api.projectDiff(projectId!));
    try {
      const [listed, diff] = await Promise.all([listFiles(), readDiff().catch(() => undefined)]);
      setListing(listed.listing);
      setStatuses(new Map((diff?.diff.files ?? []).map((file) => [file.path, file.status])));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  const workspacePath = listing?.workspacePath;
  useEffect(() => {
    if (workspacePath) onWorkspacePath?.(workspacePath);
  }, [workspacePath, onWorkspacePath]);

  const searched = useMemo(() => matchFiles(listing?.files ?? [], query), [listing, query]);
  const tree = useMemo(() => buildFileTree(searched.files), [searched.files]);
  const searching = query.trim().length > 0;
  const expanded = useMemo(
    () => (searching ? new Set(directoryPaths(tree).filter((path) => !shutWhileSearching.has(path))) : opened),
    [searching, tree, shutWhileSearching, opened],
  );
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const dirty = useMemo(() => ancestorsOf(statuses.keys()), [statuses]);
  const openTabs = useMemo(() => new Set(openPaths), [openPaths]);

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

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  const collapseAll = useCallback(() => {
    if (searching) setShutWhileSearching(new Set(directoryPaths(tree)));
    else setOpened(new Set());
  }, [searching, tree]);

  const revealPath = reveal?.path;
  const revealNonce = reveal?.nonce;
  const revealing = useRef<string>(undefined);
  useEffect(() => {
    if (!revealPath) return undefined;
    revealing.current = revealPath;
    const task = window.setTimeout(() => {
      setQuery("");
      setShutWhileSearching(new Set());
      setOpened((current) => new Set([...current, ...ancestorsOf([revealPath])]));
    }, 0);
    return () => window.clearTimeout(task);
  }, [revealPath, revealNonce]);

  useEffect(() => {
    const path = revealing.current;
    if (path === undefined) return;
    if (searching || ![...ancestorsOf([path])].every((directory) => expanded.has(directory))) return;
    revealing.current = undefined;
    rowsRef.current.get(path)?.scrollIntoView({ block: "nearest" });
  }, [searching, expanded, rows]);

  const files = useWorkspaceFileMenu({ workspacePath, hostId });

  const focusRow = useCallback((path: string | undefined) => {
    if (path === undefined) return;
    setFocusedPath(path);
    rowsRef.current.get(path)?.focus();
  }, []);

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
      for (let above = index - 1; above >= 0; above -= 1) {
        if (rows[above]!.depth < row.depth) return focusRow(rows[above]!.node.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.node.kind === "directory") return toggle(row.node.path);
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
  if (listing?.availability === "unmounted") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The drive is not connected">
        This project lives on a drive that is not plugged in. Its files are still on it — reconnect the drive and the tree comes back.
      </PanelEmpty>
    );
  }
  if (listing?.availability === "missing") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The project folder is gone">
        {listing.workspacePath} is not on this machine any more.
      </PanelEmpty>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex h-full min-h-0 flex-col" />}>
        <div className={cn(EDITOR_HEADER_ROW, "gap-1")}>
          <button
            type="button"
            aria-label="Refresh the file list"
            title={refreshing ? "Refreshing…" : "Refresh files"}
            onClick={refresh}
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
                setShutWhileSearching(new Set());
              }}
              onContextMenu={(event) => event.stopPropagation()}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!listing ? (
            <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
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
                  {...(workspaceFilePath(workspacePath, row.node.path) ? { absolute: workspaceFilePath(workspacePath, row.node.path)! } : {})}
                  files={files}
                  onCollapseAll={collapseAll}
                  {...(onInsertReference ? { onInsertReference } : {})}
                  {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
                />
              ))}
            </div>
          )}
        </div>

        {listing && (
          <p className="shrink-0 border-t border-border px-3 py-2 text-2xs leading-snug text-muted-foreground">
            {searching
              ? `${searched.matches.toLocaleString("en-US")} of ${listing.files.length.toLocaleString("en-US")} paths match${
                  searched.truncated ? `, showing the first ${searched.files.length}` : ""
                }.`
              : `${listing.files.length.toLocaleString("en-US")} files${listing.truncated ? " (capped)" : ""} · ${
                  listing.repository ? "tracked and unignored, from git" : "walked — this directory is not a repository"
                }`}
          </p>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={refresh}>Refresh</ContextMenuItem>
        <ContextMenuItem onClick={collapseAll}>Collapse all</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
