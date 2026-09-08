"use client";

/**
 * A NOTEBOOK, OPEN IN THE PANEL — read, edited, and run in the session's kernel.
 *
 * THE FILE IS THE TRUTH, for the human and the agent alike. Every run goes to
 * the engine, which executes in the session's kernel and writes outputs back
 * into the .ipynb; this surface then re-reads. So a cell the agent ran with
 * `notebook_run_cell` appears here with its output, and a cell you ran here
 * is what `notebook_open` reports. There is no second copy.
 *
 * EDITS ARE SAVED THROUGH THE SAME HASH FENCE AS ANY FILE: a source change goes
 * to the engine's notebook/edit verb with the sha the read returned, and a
 * stale one is refused rather than merged. Autosave on a debounce, like the
 * file view; ⇧⏎ runs the cell (and saves first).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CirclePlayIcon, NotebookIcon, PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import type { CellOutput, KernelState, NotebookCell, NotebookRead } from "@/lib/ds";
import { Button } from "@/components/ui/button";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { MessageResponse } from "@/components/ui/message";
import { OverlayEditor } from "./overlay-editor";
import { CellOutputView } from "./cell-output";
import { KernelPill } from "./kernel-pill";
import { cn } from "@/lib/utils";

const api = createEngineApi();
const SAVE_DEBOUNCE_MS = 600;

export function NotebookSurface({ path, sessionId, active, onOpenImage }: { path: string; sessionId?: string; active?: TurnState; onOpenImage?: (attachmentId: string) => void }) {
  const [nb, setNb] = useState<NotebookRead>();
  const [error, setError] = useState<string>();
  const [kernel, setKernel] = useState<KernelState>("none");
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Local edits not yet saved, by cell id. */
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [problem, setProblem] = useState<string>();
  const timers = useRef<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const read = await api.notebook(sessionId, path, { withOutputs: true });
      setNb(read);
      setError(undefined);
    } catch (cause) {
      if (cause instanceof EngineApiError && cause.code === "not_found") {
        setError("notfound");
      } else setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, path]);

  const refreshKernel = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.kernel(sessionId);
      setKernel(status.state);
    } catch {
      setKernel("none");
    }
  }, [sessionId]);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void load();
      void refreshKernel();
    }, 0);
    return () => window.clearTimeout(first);
  }, [load, refreshKernel, active]);

  const create = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      setNb(await api.notebookEdit(sessionId, path, { kind: "create" }));
      setError(undefined);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not create.");
    } finally {
      setBusy(false);
    }
  };

  /** Save one cell's draft now. Returns the fresh read, or undefined on refusal. */
  const saveCell = useCallback(
    async (cellId: string): Promise<NotebookRead | undefined> => {
      if (!sessionId) return undefined;
      const draft = drafts.get(cellId);
      if (draft === undefined) return nb;
      try {
        await api.notebookEdit(sessionId, path, { kind: "set", cellId, source: draft });
        const next = await api.notebook(sessionId, path, { withOutputs: true });
        setDrafts((current) => {
          const copy = new Map(current);
          if (copy.get(cellId) === draft) copy.delete(cellId);
          return copy;
        });
        setNb(next);
        setProblem(undefined);
        return next;
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : "Could not save.");
        return undefined;
      }
    },
    [sessionId, path, drafts, nb],
  );

  /** The latest saver, read by a timer that outlives the render that armed it.
   *  Written in an effect, not during render — the lint's rule, and the right one. */
  const saveCellRef = useRef(saveCell);
  useEffect(() => {
    saveCellRef.current = saveCell;
  }, [saveCell]);
  const edit = (cellId: string, source: string) => {
    setDrafts((current) => new Map(current).set(cellId, source));
    const existing = timers.current.get(cellId);
    if (existing) window.clearTimeout(existing);
    timers.current.set(cellId, window.setTimeout(() => void saveCellRef.current(cellId), SAVE_DEBOUNCE_MS));
  };
  useEffect(() => {
    const pending = timers.current;
    return () => {
      /**
       * FLUSHED, NOT CANCELLED — the same rule the file editor's coordinator
       * follows (`SaveCoordinator.dispose`). This used to clear the timers,
       * which threw away every cell edit typed in the last half second
       * whenever the notebook went away: closing its tab, switching to another
       * file in the Editor, closing the panel. The saver behind the ref writes
       * through the engine and does not need this component to still be here.
       */
      for (const [cellId, timer] of pending) {
        window.clearTimeout(timer);
        void saveCellRef.current(cellId);
      }
      pending.clear();
    };
  }, []);

  const run = async (cellId?: string) => {
    if (!sessionId || !nb) return;
    // Flush every pending draft first so the kernel runs what is on screen.
    for (const id of [...drafts.keys()]) await saveCell(id);
    setRunning((current) => new Set(current).add(cellId ?? "*"));
    setKernel((state) => (state === "none" ? "starting" : "busy"));
    try {
      await api.notebookRun(sessionId, path, cellId ? { cellId } : { all: true });
      // The run's own summary carries only each cell's LAST output; re-read
      // with outputs so a print above a table is not lost on screen.
      setNb(await api.notebook(sessionId, path, { withOutputs: true }));
      setProblem(undefined);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not run.");
    } finally {
      setRunning((current) => {
        const copy = new Set(current);
        copy.delete(cellId ?? "*");
        return copy;
      });
      void refreshKernel();
    }
  };

  const structural = async (edit: Parameters<typeof api.notebookEdit>[2]) => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.notebookEdit(sessionId, path, edit);
      setNb(await api.notebook(sessionId, path, { withOutputs: true }));
      setProblem(undefined);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not edit.");
    } finally {
      setBusy(false);
    }
  };

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
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <NotebookIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">
          {cut > -1 && <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>}
          <span className="text-foreground">{path.slice(cut + 1)}</span>
        </span>
        <KernelPill state={kernel} />
        <Button size="xs" variant="ghost" title="Run all cells" disabled={!nb || running.size > 0} onClick={() => void run()}>
          <CirclePlayIcon className="size-3" />
        </Button>
        <Button size="xs" variant="ghost" title="Interrupt" disabled={kernel !== "busy"} onClick={() => void api.kernelInterrupt(sessionId).then(refreshKernel)}>
          <SquareIcon className="size-3" />
        </Button>
        <Button size="xs" variant="ghost" title="Restart kernel — every variable is lost" disabled={kernel === "none"} onClick={() => void api.kernelRestart(sessionId).then(refreshKernel)}>
          <RotateCwIcon className="size-3" />
        </Button>
      </div>

      {problem && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-[0.6875rem] leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{problem}</span>
          {/conflict|changed on disk/i.test(problem) && (
            <Button size="xs" variant="outline" onClick={() => { setDrafts(new Map()); void load(); }}>Re-read</Button>
          )}
        </div>
      )}

      {error === "notfound" ? (
        <PanelEmpty icon={<NotebookIcon />} title="No notebook here yet">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()} className="mt-2">
            {busy ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />} Create {path.slice(cut + 1)}
          </Button>
        </PanelEmpty>
      ) : error ? (
        <PanelEmpty icon={<NotebookIcon />} title="Could not read this notebook">{error}</PanelEmpty>
      ) : !nb ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground"><Spinner className="size-3" /> reading…</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <InsertBar onInsert={(type) => void structural({ kind: "insert", after: -1, source: "", cellType: type })} />
          {cells.map((cell) => (
            <div key={cell.id}>
              <Cell
                cell={cell}
                draft={drafts.get(cell.id)}
                running={running.has(cell.id) || running.has("*")}
                sessionId={sessionId}
                onEdit={(source) => edit(cell.id, source)}
                onRun={() => void run(cell.id)}
                onDelete={() => void structural({ kind: "delete", cellId: cell.id })}
                onType={(type) => void structural({ kind: "set", cellId: cell.id, cellType: type })}
                {...(onOpenImage ? { onOpenImage } : {})}
              />
              <InsertBar onInsert={(type) => void structural({ kind: "insert", after: cell.id, source: "", cellType: type })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsertBar({ onInsert }: { onInsert: (type: "code" | "markdown") => void }) {
  return (
    <div className="group flex h-3 items-center justify-center gap-2 opacity-0 transition-opacity hover:opacity-100">
      <button type="button" onClick={() => onInsert("code")} className="rounded border border-border bg-background px-1.5 text-[0.625rem] text-muted-foreground hover:text-foreground">+ code</button>
      <button type="button" onClick={() => onInsert("markdown")} className="rounded border border-border bg-background px-1.5 text-[0.625rem] text-muted-foreground hover:text-foreground">+ markdown</button>
    </div>
  );
}

function Cell({
  cell, draft, running, sessionId, onEdit, onRun, onDelete, onType, onOpenImage,
}: {
  cell: NotebookCell;
  draft?: string;
  running: boolean;
  sessionId: string;
  onEdit: (source: string) => void;
  onRun: () => void;
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
    <div className={cn("group/cell mx-2 my-1 rounded-md border border-border/70 bg-background/40", running && "border-primary/50", failed && !running && "border-destructive/40")}>
      <div className="flex items-start gap-1">
        <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 pt-1.5">
          {cell.type === "code" ? (
            <>
              <button type="button" onClick={onRun} disabled={running} title="Run (⇧⏎)" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                {running ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
              </button>
              <span className="font-mono text-[0.5625rem] text-muted-foreground tabular-nums">[{cell.executionCount ?? " "}]</span>
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
          <button type="button" title={cell.type === "code" ? "Make markdown" : "Make code"} onClick={() => onType(cell.type === "code" ? "markdown" : "code")} className="rounded px-1 text-[0.5625rem] text-muted-foreground hover:text-foreground">
            {cell.type === "code" ? "md" : "py"}
          </button>
          <button type="button" title="Delete cell" onClick={onDelete} className="rounded p-0.5 text-muted-foreground hover:text-destructive">
            <Trash2Icon className="size-3" />
          </button>
        </div>
      </div>
      {cell.type === "code" && outputs.length > 0 && (
        <div className="border-t border-border/60">
          <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex w-full items-center gap-1 px-2 py-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground hover:text-foreground">
            {collapsed ? <ChevronRightIcon className="size-2.5" /> : <ChevronDownIcon className="size-2.5" />}
            {outputs.length} output{outputs.length === 1 ? "" : "s"}
          </button>
          {!collapsed && outputs.map((output, index) => <CellOutputView key={index} output={output} sessionId={sessionId} {...(onOpenImage ? { onOpenImage } : {})} />)}
        </div>
      )}
    </div>
  );
}
