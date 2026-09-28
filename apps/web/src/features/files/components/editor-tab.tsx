"use client";

import { XIcon } from "lucide-react";
import {
  activateEditorFile,
  editorPaths,
  editorPathsAfter,
  otherEditorPaths,
  pinEditorFile,
  type EditorState,
} from "../editor-workspace";
import { workspaceFilePath, type WorkspaceFileMenu } from "../workspace-open";
import type { SaveState } from "../hooks/use-editor-tabs";
import { FileKindIcon } from "./file-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { cn } from "@/ui/utils";

export function EditorTab({
  entry,
  state,
  onState,
  status,
  confirming,
  workspacePath,
  files,
  onClose,
  onCloseMany,
  onCancelConfirm,
  onRevealInTree,
}: {
  entry: EditorState["files"][number];
  state: EditorState;
  onState: (next: (current: EditorState) => EditorState) => void;
  status: SaveState | undefined;
  confirming: boolean;
  workspacePath: string | undefined;
  files: WorkspaceFileMenu;
  onClose: (path: string) => void;
  onCloseMany: (paths: readonly string[]) => void;
  onCancelConfirm: (path: string) => void;
  onRevealInTree: (path: string) => void;
}) {
  const on = entry.path === state.activePath;
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1) || entry.path;
  return (
    <span
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
              onClose(entry.path);
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
            aria-label={confirming ? `Close ${name} and discard the unsaved text` : `Close ${name}`}
            title={confirming ? "Not saved — click again to close and discard" : "Close"}
            onClick={() => onClose(entry.path)}
            onBlur={() => onCancelConfirm(entry.path)}
            className={cn(
              "ml-1 rounded p-0.5 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
              confirming
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
          <ContextMenuItem onClick={() => onClose(entry.path)}>Close</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(otherEditorPaths(state, entry.path))}>Close others</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(editorPathsAfter(state, entry.path))}>Close to the right</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(editorPaths(state))}>Close all</ContextMenuItem>
          <ContextMenuSeparator />
          {!entry.pinned && <ContextMenuItem onClick={() => onState((current) => pinEditorFile(current, entry.path))}>Pin</ContextMenuItem>}
          <ContextMenuItem onClick={() => onRevealInTree(entry.path)}>Reveal in file tree</ContextMenuItem>
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
}
