"use client";

import { useState, useSyncExternalStore } from "react";
import { EyeIcon, FileIcon, PencilIcon, RotateCwIcon, WrapTextIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import { EditorAddressRow } from "./editor-chrome";
import { MessageResponse } from "@/ui/message";
import { PanelEmpty } from "@/ui/panel";
import { Spinner } from "@/ui/spinner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/context-menu";
import type { TelarReference } from "@/features/composer";
import type { EditorViewState } from "../editor-workspace";
import {
  isProseFile,
  NOWRAP_CLASS,
  serverWrapLinesSnapshot,
  subscribeWrapLines,
  WRAP_CLASS,
  wrapLinesSnapshot,
  writeWrapLines,
} from "../editor-wrap";
import { fileKind } from "../file-kinds";
import { rawFileUrl } from "../file-urls";
import { useWorkspaceFileMenu, workspaceFilePath } from "../workspace-open";
import { cn } from "@/ui/utils";
import { useFileEditor, type SaveState } from "../hooks/use-file-editor";
import { formatBytes } from "../model";
import { BinaryFile, CodeEditor, MarkdownToolbar, SaveRefusal } from "./file-body";
import { FileMenuItems } from "./file-menu";

type Props = {
  path: string;
  sessionId?: string;
  projectId?: string;
  /** Pins the engine client and keys the unsaved-text stash: two engines can mint the same session id. */
  hostId?: string;
  /** A turn settling is when the file on disk may have changed, so it re-reads. */
  active?: TurnState;
  /** Called from the saver itself, so a flush that lands after unmount still reports. */
  onSaveState?: (state: SaveState) => void;
  onEdit?: () => void;
  readView?: () => EditorViewState | undefined;
  onView?: (view: EditorViewState) => void;
  /** Without it the menu cannot name the file on disk, so path, reveal and open are hidden. */
  workspacePath?: string;
  onInsertReference?: (reference: TelarReference) => void;
  onOpenInNewPanelTab?: (path: string) => void;
};

export function FileViewSurface(props: Props) {
  const { path, sessionId, projectId, hostId, workspacePath, onInsertReference, onOpenInNewPanelTab, onEdit } = props;
  const kind = fileKind(path);
  const editor = useFileEditor({ ...props, lang: kind.lang });
  const { file, draft, editable, load } = editor;
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource] = useState(false);
  const markdown = kind.lang === "markdown";
  const prose = isProseFile(kind);
  const wrap = useSyncExternalStore(subscribeWrapLines, wrapLinesSnapshot, serverWrapLinesSnapshot);
  const wrapping = prose && wrap;
  const showWrap = prose && editable && (!markdown || source);
  const showMarkdownToggle = Boolean(markdown && file && !file.binary);
  const reread = () => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };
  const files = useWorkspaceFileMenu({ workspacePath, hostId });
  const absolute = workspaceFilePath(workspacePath, path);
  const menu = (
    <FileMenuItems
      path={path}
      {...(absolute ? { absolute } : {})}
      files={files}
      onReread={reread}
      {...(showWrap ? { wrap: { on: wrap } } : {})}
      onWrap={(on) => writeWrapLines(on)}
      markdown={showMarkdownToggle}
      source={source}
      onSource={setSource}
      {...(onInsertReference ? { onInsertReference } : {})}
      {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
    />
  );
  const mediaUrl =
    file && kind.media
      ? rawFileUrl(path, { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), version: file.sha256 })
      : undefined;

  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<FileIcon />} title="No project">
        This file belongs to a checkout, and there is not one to name yet.
      </PanelEmpty>
    );
  }

  const body = editor.error ? (
    <PanelEmpty icon={<FileIcon />} title="Could not read this file">
      {editor.error}
    </PanelEmpty>
  ) : !file || draft === undefined ? (
    file?.binary ? (
      <BinaryFile path={path} file={file} kind={kind} mediaUrl={mediaUrl} />
    ) : (
      <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> reading the file…
      </p>
    )
  ) : markdown && !source ? (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <MessageResponse className="text-xs-plus">{draft}</MessageResponse>
    </div>
  ) : (
    <>
      {markdown && editable && source && <MarkdownToolbar onEdit={editor.applyEdit} />}
      <CodeEditor
        path={path}
        file={file}
        draft={draft}
        lines={editor.lines}
        coloured={editor.coloured}
        editable={editable}
        wrapping={wrapping}
        wrapClass={wrapping ? WRAP_CLASS : NOWRAP_CLASS}
        lang={kind.lang}
        kindLabel={kind.label}
        textareaRef={editor.textareaRef}
        scrollerRef={editor.scrollerRef}
        onChange={(text) => {
          editor.change(text);
          onEdit?.();
          editor.rememberView();
        }}
        onView={editor.rememberView}
        onSave={editor.flush}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ContextMenu>
        {/* A real box, not `display: contents`: a contents element is never an event target. */}
        <ContextMenuTrigger render={<div className="shrink-0" />}>
          <EditorAddressRow
            path={path}
            detail={
              editor.dirty || file ? (
                <>
                  {editor.dirty && (
                    <span
                      aria-label="Unsaved changes"
                      title={editor.problem ? "Not saved — see the message below" : "Saving…"}
                      className={cn("size-1.5 shrink-0 rounded-full", editor.problem ? "bg-destructive" : "bg-primary")}
                    />
                  )}
                  {file && formatBytes(file.bytes)}
                </>
              ) : undefined
            }
          >
            {showWrap && <WrapSwitch on={wrap} />}
            {showMarkdownToggle && <MarkdownViewToggle source={source} onSource={setSource} />}
            <button
              type="button"
              aria-label="Re-read this file"
              title="Re-read from disk"
              onClick={reread}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
            </button>
          </EditorAddressRow>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
          {editor.problem && <SaveRefusal problem={editor.problem} onReread={() => void load(true)} />}
          {body}
        </ContextMenuTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function WrapSwitch({ on }: { on: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Wrap lines"
      title={on ? "Wrap lines: on (line numbers hidden while wrapped)" : "Wrap long lines to the panel width"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => writeWrapLines(!on)}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs transition-colors",
        on ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <WrapTextIcon className="size-3" />
      Wrap
    </button>
  );
}

function MarkdownViewToggle({ source, onSource }: { source: boolean; onSource: (source: boolean) => void }) {
  return (
    <div role="group" aria-label="Markdown view" className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
      <button
        type="button"
        aria-pressed={!source}
        title="Rendered"
        onClick={() => onSource(false)}
        className={cn("rounded p-0.5 transition-colors", source ? "text-muted-foreground hover:text-foreground" : "bg-secondary text-foreground")}
      >
        <EyeIcon className="size-3" />
      </button>
      <button
        type="button"
        aria-pressed={source}
        title="Edit source"
        onClick={() => onSource(true)}
        className={cn("rounded p-0.5 transition-colors", source ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
      >
        <PencilIcon className="size-3" />
      </button>
    </div>
  );
}
