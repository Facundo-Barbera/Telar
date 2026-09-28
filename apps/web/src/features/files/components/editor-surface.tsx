"use client";

import { useCallback, useState } from "react";
import { FileIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import {
  activeEditorFile,
  editorPaths,
  pinEditorFile,
  setExplorerOpen,
  type EditorState,
  type EditorViewState,
} from "../editor-workspace";
import { draftScope } from "../editor-drafts";
import type { TelarReference } from "@/features/composer";
import { useWorkspaceFileMenu } from "../workspace-open";
import { useEditorTabs, type SaveState } from "../hooks/use-editor-tabs";
import { EDITOR_HEADER_ROW } from "./editor-chrome";
import { EditorTab } from "./editor-tab";
import { FilesSurface } from "./files-surface";
import { FileViewSurface } from "./file-view-surface";
import { NotebookSurface } from "@/features/plugins";
import { PdfSurface } from "./pdf-surface";
import { TableSurface } from "./table-surface";
import { PanelEmpty } from "@/ui/panel";
import { cn } from "@/ui/utils";

const EXPLORER_WIDTH = "13rem";

const NO_PLUGINS: readonly string[] = [];

function EditorBody({
  state,
  onState,
  sessionId,
  projectId,
  hostId,
  active,
  workspacePath,
  views,
  reportSave,
  onOpenImage,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  state: EditorState;
  onState: (next: (current: EditorState) => EditorState) => void;
  sessionId?: string | undefined;
  projectId?: string | undefined;
  hostId?: string | undefined;
  active?: TurnState | undefined;
  workspacePath: string | undefined;
  views: { current: Map<string, EditorViewState> };
  reportSave: (path: string, next: "clean" | SaveState) => void;
  onOpenImage?: ((attachmentId: string) => void) | undefined;
  onInsertReference?: ((reference: TelarReference) => void) | undefined;
  onOpenInNewPanelTab?: ((path: string) => void) | undefined;
}) {
  const file = activeEditorFile(state);
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
}

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
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [reveal, setReveal] = useState<{ path: string; nonce: number }>();
  const open = editorPaths(state);
  const tabs = useEditorTabs({ onState, enabledPlugins, scope: draftScope(hostId, sessionId, projectId) });

  const revealInTree = useCallback(
    (path: string) => {
      onState((current) => setExplorerOpen(current, true));
      setReveal((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
    },
    [onState],
  );

  const files = useWorkspaceFileMenu({ workspacePath, hostId });

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
            onOpenFile={tabs.openFile}
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
            {state.files.map((entry) => (
              <EditorTab
                key={entry.path}
                entry={entry}
                state={state}
                onState={onState}
                status={tabs.saving.get(entry.path)}
                confirming={tabs.confirming === entry.path}
                workspacePath={workspacePath}
                files={files}
                onClose={tabs.close}
                onCloseMany={tabs.closeMany}
                onCancelConfirm={tabs.cancelConfirm}
                onRevealInTree={revealInTree}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <EditorBody
            state={state}
            onState={onState}
            sessionId={sessionId}
            projectId={projectId}
            hostId={hostId}
            active={active}
            workspacePath={workspacePath}
            views={tabs.views}
            reportSave={tabs.reportSave}
            onOpenImage={onOpenImage}
            onInsertReference={onInsertReference}
            onOpenInNewPanelTab={onOpenInNewPanelTab}
          />
        </div>
      </div>
    </div>
  );
}
