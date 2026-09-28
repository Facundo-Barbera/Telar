"use client";

import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CirclePlayIcon, NotebookIcon, PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import type { CellOutput, NotebookCell, NotebookRead } from "./ds";
import { EditorAddressRow, OverlayEditor } from "@/features/files";
import { Button } from "@/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/context-menu";
import { PanelEmpty } from "@/ui/panel";
import { Spinner } from "@/ui/spinner";
import { MessageResponse } from "@/ui/message";
import { CellOutputView } from "./cell-output";
import { KernelPill } from "./kernel-pill";
import { useNotebook, type NotebookEdit, type NotebookReadFailure } from "./use-notebook";
import { cn } from "@/ui/utils";

function NotebookBanners({
  problem,
  failure,
  nb,
  onReread,
  onRetry,
}: {
  problem: string | undefined;
  failure: NotebookReadFailure | undefined;
  nb: NotebookRead | undefined;
  onReread: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      {problem && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-2xs leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{problem}</span>
          {/conflict|changed on disk/i.test(problem) && (
            <Button size="xs" variant="outline" onClick={onReread}>Re-read</Button>
          )}
        </div>
      )}

      {failure && nb && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-2xs leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {failure.kind === "missing" ? "This notebook is no longer in the workspace." : failure.message}
          </span>
          <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button>
        </div>
      )}
    </>
  );
}

function NotebookCells({
  cells,
  drafts,
  running,
  sessionId,
  onEdit,
  onRun,
  onEditStructure,
  onOpenImage,
}: {
  cells: NotebookCell[];
  drafts: ReadonlyMap<string, string>;
  running: ReadonlySet<string>;
  sessionId: string;
  onEdit: (cellId: string, source: string) => void;
  onRun: (cellId?: string) => void;
  onEditStructure: (edit: NotebookEdit) => void;
  onOpenImage?: ((attachmentId: string) => void) | undefined;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <InsertBar onInsert={(type) => onEditStructure({ kind: "insert", after: -1, source: "", cellType: type })} />
      {cells.map((cell) => (
        <div key={cell.id}>
          <Cell
            cell={cell}
            count={cells.length}
            draft={drafts.get(cell.id)}
            running={running.has(cell.id) || running.has("*")}
            sessionId={sessionId}
            onEdit={(source) => onEdit(cell.id, source)}
            onRun={() => onRun(cell.id)}
            onRunAll={() => onRun()}
            onInsert={(where) =>
              onEditStructure({ kind: "insert", after: where === "above" ? cell.index - 1 : cell.id, source: "", cellType: "code" })
            }
            onMove={(to) => onEditStructure({ kind: "move", cellId: cell.id, to })}
            onClearOutputs={() => onEditStructure({ kind: "clearOutputs", cellId: cell.id })}
            onDelete={() => onEditStructure({ kind: "delete", cellId: cell.id })}
            onType={(type) => onEditStructure({ kind: "set", cellId: cell.id, cellType: type })}
            {...(onOpenImage ? { onOpenImage } : {})}
          />
          <InsertBar onInsert={(type) => onEditStructure({ kind: "insert", after: cell.id, source: "", cellType: type })} />
        </div>
      ))}
    </div>
  );
}

export function NotebookSurface({ path, sessionId, hostId, active, onOpenImage }: { path: string; sessionId?: string; hostId?: string; active?: TurnState; onOpenImage?: (attachmentId: string) => void }) {
  const notebook = useNotebook({ path, sessionId, hostId, active });
  const { api, nb, failure, kernel, running, busy, load, refreshKernel } = notebook;
  const cells = useMemo(() => nb?.cells ?? [], [nb]);
  const cut = path.lastIndexOf("/");

  if (!sessionId) {
    return (
      <PanelEmpty icon={<NotebookIcon />} title="No session">
        A notebook runs in a session&apos;s kernel, and there is not one yet.
      </PanelEmpty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorAddressRow path={path} icon={<NotebookIcon className="size-3.5 shrink-0 text-muted-foreground" />}>
        <KernelPill state={kernel} />
        <Button size="xs" variant="ghost" title="Run all cells" disabled={!nb || running.size > 0} onClick={() => void notebook.run()}>
          <CirclePlayIcon className="size-3" />
        </Button>
        <Button size="xs" variant="ghost" title="Interrupt" disabled={kernel !== "busy"} onClick={() => void api.kernelInterrupt(sessionId).then(refreshKernel)}>
          <SquareIcon className="size-3" />
        </Button>
        <Button size="xs" variant="ghost" title="Restart kernel — every variable is lost" disabled={kernel === "none"} onClick={() => void api.kernelRestart(sessionId).then(refreshKernel)}>
          <RotateCwIcon className="size-3" />
        </Button>
      </EditorAddressRow>

      <NotebookBanners
        problem={notebook.problem}
        failure={failure}
        nb={nb}
        onReread={() => {
          notebook.clearDrafts();
          void load();
        }}
        onRetry={() => void load()}
      />

      {nb ? (
        <NotebookCells
          cells={cells}
          drafts={notebook.drafts}
          running={running}
          sessionId={sessionId}
          onEdit={notebook.edit}
          onRun={(cellId) => void notebook.run(cellId)}
          onEditStructure={(edit) => void notebook.structural(edit)}
          onOpenImage={onOpenImage}
        />
      ) : failure?.kind === "missing" ? (
        <PanelEmpty icon={<NotebookIcon />} title="No notebook here yet">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void notebook.create()} className="mt-2">
            {busy ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />} Create {path.slice(cut + 1)}
          </Button>
        </PanelEmpty>
      ) : failure ? (
        <PanelEmpty icon={<TriangleAlertIcon />} title="Could not read this notebook">
          <span className="block max-w-prose text-balance">{failure.message}</span>
          <Button size="sm" variant="outline" onClick={() => void load()} className="mt-3">
            <RotateCwIcon className="size-3" /> Retry
          </Button>
        </PanelEmpty>
      ) : (
        <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
          <Spinner className="size-3" /> {notebook.read ? "reading…" : "opening…"}
        </p>
      )}
    </div>
  );
}

function InsertBar({ onInsert }: { onInsert: (type: "code" | "markdown") => void }) {
  return (
    <div className="group flex h-3 items-center justify-center gap-2 opacity-0 transition-opacity hover:opacity-100">
      <button type="button" onClick={() => onInsert("code")} className="rounded border border-border bg-background px-1.5 text-3xs text-muted-foreground hover:text-foreground">+ code</button>
      <button type="button" onClick={() => onInsert("markdown")} className="rounded border border-border bg-background px-1.5 text-3xs text-muted-foreground hover:text-foreground">+ markdown</button>
    </div>
  );
}

function CellMenu({
  cell, count, source, collapsed, running, onRun, onRunAll, onInsert, onMove, onClearOutputs, onDelete, onType, onCollapse, children,
}: {
  cell: NotebookCell;
  count: number;
  source: string;
  collapsed: boolean;
  running: boolean;
  onRun: () => void;
  onRunAll: () => void;
  onInsert: (where: "above" | "below") => void;
  onMove: (to: number) => void;
  onClearOutputs: () => void;
  onDelete: () => void;
  onType: (type: "code" | "markdown") => void;
  onCollapse: () => void;
  children: React.ReactNode;
}) {
  const code = cell.type === "code";
  const outputs = cell.outputs?.length ?? 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        {code && (
          <ContextMenuItem disabled={running} onClick={onRun}>
            Run cell
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={running} onClick={onRunAll}>
          Run all
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onInsert("above")}>Insert cell above</ContextMenuItem>
        <ContextMenuItem onClick={() => onInsert("below")}>Insert cell below</ContextMenuItem>
        <ContextMenuItem disabled={cell.index === 0} onClick={() => onMove(cell.index - 1)}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={cell.index >= count - 1} onClick={() => onMove(cell.index + 1)}>
          Move down
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onType(code ? "markdown" : "code")}>{code ? "Change to Markdown" : "Change to Code"}</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          Delete cell
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(source)}>Copy source</ContextMenuItem>
        {code && outputs > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onCollapse}>{collapsed ? "Expand outputs" : "Collapse outputs"}</ContextMenuItem>
            <ContextMenuItem onClick={onClearOutputs}>Clear outputs</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Cell({
  cell, count, draft, running, sessionId, onEdit, onRun, onRunAll, onInsert, onMove, onClearOutputs, onDelete, onType, onOpenImage,
}: {
  cell: NotebookCell;
  count: number;
  draft?: string;
  running: boolean;
  sessionId: string;
  onEdit: (source: string) => void;
  onRun: () => void;
  onRunAll: () => void;
  onInsert: (where: "above" | "below") => void;
  onMove: (to: number) => void;
  onClearOutputs: () => void;
  onDelete: () => void;
  onType: (type: "code" | "markdown") => void;
  onOpenImage?: (attachmentId: string) => void;
}) {
  const [editingMarkdown, setEditingMarkdown] = useState(cell.type === "markdown" && cell.source === "");
  const [collapsed, setCollapsed] = useState(false);
  const source = draft ?? cell.source;
  const outputs: CellOutput[] = cell.outputs ?? [];
  const failed = outputs.some((o) => o.kind === "error");

  const keys = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (cell.type === "markdown") setEditingMarkdown(false);
      else onRun();
    }
    if (event.key === "Escape" && cell.type === "markdown") setEditingMarkdown(false);
  };

  return (
    <CellMenu
      cell={cell}
      count={count}
      source={source}
      collapsed={collapsed}
      running={running}
      onRun={onRun}
      onRunAll={onRunAll}
      onInsert={onInsert}
      onMove={onMove}
      onClearOutputs={onClearOutputs}
      onDelete={onDelete}
      onType={onType}
      onCollapse={() => setCollapsed((v) => !v)}
    >
    <div className={cn("group/cell mx-2 my-1 rounded-md border border-border/70 bg-background/40", running && "border-primary/50", failed && !running && "border-destructive/40")}>
      <div className="flex items-start gap-1">
        <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 pt-1.5">
          {cell.type === "code" ? (
            <>
              <button type="button" onClick={onRun} disabled={running} title="Run (⇧⏎)" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                {running ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
              </button>
              <span className="font-mono text-4xs text-muted-foreground tabular-nums">[{cell.executionCount ?? " "}]</span>
            </>
          ) : (
            <button type="button" onClick={() => setEditingMarkdown((v) => !v)} title="Edit markdown" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
              {editingMarkdown ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {cell.type === "markdown" && !editingMarkdown ? (
            <div className="px-2 py-1.5 text-sm" onDoubleClick={() => setEditingMarkdown(true)}>
              {source.trim() ? <MessageResponse>{source}</MessageResponse> : <span className="text-xs italic text-muted-foreground">empty markdown — double-click to edit</span>}
            </div>
          ) : (
            <OverlayEditor
              value={source}
              onChange={onEdit}
              language={cell.type === "code" ? "python" : "markdown"}
              ariaLabel={`Cell ${cell.index} source`}
              onKeyDown={keys}
              minRows={1}
              autoFocus={cell.type === "markdown" && editingMarkdown}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-1 opacity-0 transition-opacity group-hover/cell:opacity-100">
          <button type="button" title={cell.type === "code" ? "Make markdown" : "Make code"} onClick={() => onType(cell.type === "code" ? "markdown" : "code")} className="rounded px-1 text-4xs text-muted-foreground hover:text-foreground">
            {cell.type === "code" ? "md" : "py"}
          </button>
          <button type="button" title="Delete cell" onClick={onDelete} className="rounded p-0.5 text-muted-foreground hover:text-destructive">
            <Trash2Icon className="size-3" />
          </button>
        </div>
      </div>
      {cell.type === "code" && outputs.length > 0 && (
        <div className="border-t border-border/60">
          <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex w-full items-center gap-1 px-2 py-0.5 text-4xs uppercase tracking-wide text-muted-foreground hover:text-foreground">
            {collapsed ? <ChevronRightIcon className="size-2.5" /> : <ChevronDownIcon className="size-2.5" />}
            {outputs.length} output{outputs.length === 1 ? "" : "s"}
          </button>
          {!collapsed && outputs.map((output, index) => <CellOutputView key={index} output={output} sessionId={sessionId} {...(onOpenImage ? { onOpenImage } : {})} />)}
        </div>
      )}
    </div>
    </CellMenu>
  );
}
