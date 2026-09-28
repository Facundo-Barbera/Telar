"use client";

import { useCallback, useRef, useState } from "react";
import { FileIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import {
  activateEditorFile,
  activeEditorFile,
  closeEditorFile,
  editorFileForPath,
  editorPaths,
  editorPathsAfter,
  openInEditor,
  otherEditorPaths,
  pinEditorFile,
  setExplorerOpen,
  type EditorState,
  type EditorViewState,
  type OpenIntent,
} from "../editor-workspace";
import { discardDraft, draftScope } from "../editor-drafts";
import type { TelarReference } from "@/features/composer";
import { useWorkspaceFileMenu, workspaceFilePath } from "../workspace-open";
import { EDITOR_HEADER_ROW } from "./editor-chrome";
import { FileKindIcon } from "./file-icon";
import { FilesSurface } from "./files-surface";
import { FileViewSurface } from "./file-view-surface";
import { NotebookSurface } from "@/features/plugins";
import { PdfSurface } from "./pdf-surface";
import { TableSurface } from "./table-surface";
import { PanelEmpty } from "@/ui/panel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { cn } from "@/ui/utils";

const EXPLORER_WIDTH = "13rem";

type SaveState = "saving" | "problem";

const NO_PLUGINS: readonly string[] = [];

export function EditorSurface({
  state,
  onState,
  sessionId,
  projectId,
  hostId,
  active,
  enabledPlugins = NO_PLUGINS,
  onOpenImage,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  state: EditorState;
  onState: (next: (current: EditorState) => EditorState) => void;
  sessionId?: string;
  projectId?: string;
  hostId?: string;
  active?: TurnState;
  enabledPlugins?: readonly string[];
  onOpenImage?: (attachmentId: string) => void;
  onInsertReference?: (reference: TelarReference) => void;
  onOpenInNewPanelTab?: (path: string) => void;
}) {
  const views = useRef(new Map<string, EditorViewState>());
  const [saving, setSaving] = useState<ReadonlyMap<string, SaveState>>(new Map());
  const [confirming, setConfirming] = useState<string>();
  const closed = useRef(new Set<string>());
  const closingWhenClean = useRef(new Set<string>());
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [reveal, setReveal] = useState<{ path: string; nonce: number }>();

  const file = activeEditorFile(state);
  const open = editorPaths(state);
  const scope = draftScope(hostId, sessionId, projectId);

  const openFile = useCallback(
    (path: string, intent: OpenIntent) => {
      closed.current.delete(path);
      closingWhenClean.current.delete(path);
      onState((current) => openInEditor(current, editorFileForPath(path, enabledPlugins), intent));
    },
    [onState, enabledPlugins],
  );

  const forget = useCallback(
    (path: string) => {
      setConfirming((current) => (current === path ? undefined : current));
      views.current.delete(path);
      closingWhenClean.current.delete(path);
      closed.current.add(path);
      setSaving((current) => {
        if (!current.has(path)) return current;
        const next = new Map(current);
        next.delete(path);
        return next;
      });
      onState((current) => closeEditorFile(current, path));
    },
    [onState],
  );

  const close = useCallback(
    (path: string) => {
      const status = saving.get(path);
      if (status === "problem") {
        if (confirming !== path) {
          setConfirming(path);
          return;
        }
        discardDraft(scope, path);
        forget(path);
        return;
      }
      if (status === "saving") {
        closingWhenClean.current.add(path);
        return;
      }
      forget(path);
    },
    [saving, confirming, forget, scope],
  );

  const closeMany = useCallback((paths: readonly string[]) => paths.forEach((path) => close(path)), [close]);

  const revealInTree = useCallback(
    (path: string) => {
      onState((current) => setExplorerOpen(current, true));
      setReveal((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
    },
    [onState],
  );

  const files = useWorkspaceFileMenu({ workspacePath, hostId });

  const reportSave = useCallback(
    (path: string, next: "clean" | SaveState) => {
      if (closed.current.has(path)) return;
      if (next === "clean" && closingWhenClean.current.has(path)) {
        forget(path);
        return;
      }
      if (next === "problem" && closingWhenClean.current.delete(path)) setConfirming(path);
      setSaving((current) => {
        if (next === "clean" ? !current.has(path) : current.get(path) === next) return current;
        const updated = new Map(current);
        if (next === "clean") updated.delete(path);
        else updated.set(path, next);
        return updated;
      });
    },
    [forget],
  );

  const body = () => {
    if (!file) {
      return (
        <PanelEmpty icon={<FileIcon />} title="No file open">
          {state.explorerOpen ? "Click a file in the tree to look at it; double-click to keep it open." : "Show the tree to open a file."}
        </PanelEmpty>
      );
    }
    const key = `${hostId ?? "local"}:${sessionId ?? projectId ?? "none"}:${file.path}`;
    if (file.view === "notebook") {
      return (
        <NotebookSurface
          key={key}
          path={file.path}
          {...(sessionId ? { sessionId } : {})}
          {...(hostId ? { hostId } : {})}
          {...(active ? { active } : {})}
          {...(onOpenImage ? { onOpenImage } : {})}
        />
      );
    }
    if (file.view === "table") {
      return <TableSurface key={key} path={file.path} {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} />;
    }
    if (file.view === "pdf") {
      return (
        <PdfSurface key={key} path={file.path} {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} {...(active ? { active } : {})} />
      );
    }
    return (
      <FileViewSurface
        key={key}
        path={file.path}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(hostId ? { hostId } : {})}
        {...(active ? { active } : {})}
        readView={() => views.current.get(file.path)}
        onView={(where) => views.current.set(file.path, where)}
        onSaveState={(next) => reportSave(file.path, next)}
        onEdit={() => onState((current) => pinEditorFile(current, file.path))}
        {...(workspacePath ? { workspacePath } : {})}
        {...(onInsertReference ? { onInsertReference } : {})}
        {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0">
      {state.explorerOpen && (
        <div
          style={{ width: EXPLORER_WIDTH }}
          className="flex min-h-0 shrink-0 flex-col border-r border-border"
        >
          <FilesSurface
            {...(sessionId ? { sessionId } : {})}
            {...(projectId ? { projectId } : {})}
            {...(hostId ? { hostId } : {})}
            openPaths={open}
            onOpenFile={openFile}
            onWorkspacePath={setWorkspacePath}
            {...(onInsertReference ? { onInsertReference } : {})}
            {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
            {...(reveal ? { reveal } : {})}
            {...(active ? { active } : {})}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className={cn(EDITOR_HEADER_ROW, "gap-1")}>
          <button
            type="button"
            aria-label={state.explorerOpen ? "Hide the file tree" : "Show the file tree"}
            aria-expanded={state.explorerOpen}
            title={state.explorerOpen ? "Hide the file tree" : "Show the file tree"}
            onClick={() => onState((current) => setExplorerOpen(current, !current.explorerOpen))}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {state.explorerOpen ? <PanelLeftCloseIcon className="size-3.5" /> : <PanelLeftOpenIcon className="size-3.5" />}
          </button>
          <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {state.files.map((entry) => {
              const on = entry.path === state.activePath;
              const status = saving.get(entry.path);
              const name = entry.path.slice(entry.path.lastIndexOf("/") + 1) || entry.path;
              return (
                <span
                  key={entry.path}
                  className={cn(
                    "group/file relative flex h-7 min-w-0 max-w-44 shrink-0 rounded-md text-xs transition-colors",
                    on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <ContextMenu>
                    <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onState((current) => activateEditorFile(current, entry.path))}
                        onDoubleClick={() => onState((current) => pinEditorFile(current, entry.path))}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          close(entry.path);
                        }}
                        title={`${entry.path}${entry.pinned ? "" : " — preview; double-click to keep it open"}`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
                      >
                        <FileKindIcon path={entry.path} className="size-3.5 shrink-0" />
                        <span className={cn("truncate", !entry.pinned && "italic")}>{name}</span>
                      </button>
                      {status && (
                        <span
                          aria-label={status === "problem" ? `${name} has unsaved changes that were refused` : `${name} is saving`}
                          className={cn("ml-1 size-1.5 shrink-0 rounded-full group-hover/file:hidden", status === "problem" ? "bg-destructive" : "bg-primary")}
                        />
                      )}
                      <button
                        type="button"
                        aria-label={confirming === entry.path ? `Close ${name} and discard the unsaved text` : `Close ${name}`}
                        title={confirming === entry.path ? "Not saved — click again to close and discard" : "Close"}
                        onClick={() => close(entry.path)}
                        onBlur={() => setConfirming((current) => (current === entry.path ? undefined : current))}
                        className={cn(
                          "ml-1 rounded p-0.5 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
                          confirming === entry.path
                            ? "bg-destructive/15 text-destructive opacity-100"
                            : status
                              ? "hidden text-muted-foreground group-hover/file:block"
                              : cn("text-muted-foreground", on ? "opacity-70" : "opacity-0 group-hover/file:opacity-70"),
                        )}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => close(entry.path)}>Close</ContextMenuItem>
                      <ContextMenuItem onClick={() => closeMany(otherEditorPaths(state, entry.path))}>Close others</ContextMenuItem>
                      <ContextMenuItem onClick={() => closeMany(editorPathsAfter(state, entry.path))}>Close to the right</ContextMenuItem>
                      <ContextMenuItem onClick={() => closeMany(editorPaths(state))}>Close all</ContextMenuItem>
                      <ContextMenuSeparator />
                      {!entry.pinned && (
                        <ContextMenuItem onClick={() => onState((current) => pinEditorFile(current, entry.path))}>Pin</ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => revealInTree(entry.path)}>Reveal in file tree</ContextMenuItem>
                      <ContextMenuSeparator />
                      {workspaceFilePath(workspacePath, entry.path) && (
                        <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(workspaceFilePath(workspacePath, entry.path)!)}>
                          Copy path
                        </ContextMenuItem>
                      )}
                      {files.reveal && <ContextMenuItem onClick={() => files.reveal!(entry.path, "file")}>Reveal in Finder</ContextMenuItem>}
                    </ContextMenuContent>
                  </ContextMenu>
                </span>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">{body()}</div>
      </div>
    </div>
  );
}
