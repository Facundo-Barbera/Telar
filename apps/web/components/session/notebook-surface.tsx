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
import { EditorAddressRow } from "@/components/session/editor-chrome";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { MessageResponse } from "@/components/ui/message";
import { OverlayEditor } from "./overlay-editor";
import { CellOutputView } from "./cell-output";
import { claimCellDraft, claimCellDrafts, draftScope, forgetCellDraft, newDraftOwner, rememberCellDraft } from "@/lib/editor-drafts";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { KernelPill } from "./kernel-pill";
import { cn } from "@/lib/utils";

/**
 * THE ENGINE THIS NOTEBOOK BELONGS TO, PINNED — the same argument as the file
 * editor's (session/file-view-surface.tsx `engineFor`): a cell save is
 * debounced and flushed on unmount, so it can leave after a navigation, and
 * the default client resolves the host from the pathname AT CALL TIME.
 */
function engineFor(hostId: string | undefined) {
  return createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
}
const SAVE_DEBOUNCE_MS = 600;

/**
 * WHY A READ FAILED, AND ONLY ONE ANSWER OFFERS TO CREATE ANYTHING.
 *
 * "This notebook is not there" and "the engine could not answer" are both
 * `not_found` on the wire, and treating them as one is how an EXISTING
 * notebook came to be shown as "No notebook here yet" with a Create button
 * under it: the read had 404'd on a missing plugin route, not on a missing
 * file. So `missing` is an ALLOWLIST — the engine's own sentence about a file
 * in the workspace — and everything else, including any 404 that names a
 * method, a plugin or an endpoint, is `unreadable`: shown with what the engine
 * said and a Retry, never with an offer to create over the reader's file.
 */
export type NotebookReadFailure = { kind: "missing" } | { kind: "unreadable"; message: string };

/** The engine's words for a file that is not in the workspace (`state.ts`). */
const MISSING_FILE = /no such file in this workspace/i;
/** A 404 about the DOOR rather than the file: a route, a plugin, an endpoint. */
const NOT_THE_FILE = /\bmethod\b|\bplugin\b|\bendpoint\b|\bhas no\b|\broute\b/i;

export function classifyNotebookRead(cause: unknown): NotebookReadFailure {
  const message = cause instanceof EngineApiError ? cause.message : cause instanceof Error ? cause.message : "";
  const code = cause instanceof EngineApiError ? cause.code : undefined;
  if (code === "not_found" && MISSING_FILE.test(message) && !NOT_THE_FILE.test(message)) return { kind: "missing" };
  return {
    kind: "unreadable",
    // The engine's own sentence when there is one: "no data-science method
    // notebook/read" tells a person to look at the build, which "could not
    // read this notebook" does not.
    message: message.trim() || "The engine did not answer.",
  };
}

export function NotebookSurface({ path, sessionId, hostId, active, onOpenImage }: { path: string; sessionId?: string; hostId?: string; active?: TurnState; onOpenImage?: (attachmentId: string) => void }) {
  const [nb, setNb] = useState<NotebookRead>();
  const [failure, setFailure] = useState<NotebookReadFailure>();
  /** False until the first read has answered, so "loading" is a state of its
   *  own rather than the absence of both a notebook and an error. */
  const [read, setRead] = useState(false);
  const [kernel, setKernel] = useState<KernelState>("none");
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Local edits not yet saved, by cell id. */
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [problem, setProblem] = useState<string>();
  const timers = useRef<Map<string, number>>(new Map());
  const api = useMemo(() => engineFor(hostId), [hostId]);
  /**
   * UNSAVED CELL SOURCE, KEPT OUTSIDE THIS COMPONENT.
   *
   * Flushing the debounce on unmount saves the cells whose write SUCCEEDS. It
   * does nothing for the one that fails — the engine unreachable, the notebook
   * rewritten under it — and that text had nowhere to go but a component that
   * was already being thrown away. So every keystroke is stashed
   * (lib/editor-drafts.ts), a landed write clears it, and a re-opened notebook
   * adopts whatever is still owed. Owner-scoped for the same reason a file's
   * is: the mount you switched away from is still answering.
   */
  const owner = useRef(newDraftOwner());
  const scope = draftScope(hostId, sessionId);
  /** What the stash holds, mirrored for the save callbacks — which run after
   *  the render that armed them, and sometimes after the unmount. */
  const stash = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const answer = await api.notebook(sessionId, path, { withOutputs: true });
      setNb(answer);
      setFailure(undefined);
    } catch (cause) {
      /**
       * WHAT IS ON SCREEN IS NOT THROWN AWAY. A re-read that fails leaves the
       * cells the reader was looking at where they are, under a banner — the
       * file has not changed, only our last question about it.
       */
      setFailure(classifyNotebookRead(cause));
    } finally {
      setRead(true);
    }
  }, [sessionId, path, api]);

  const refreshKernel = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.kernel(sessionId);
      setKernel(status.state);
    } catch {
      setKernel("none");
    }
  }, [sessionId, api]);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void load();
      void refreshKernel();
    }, 0);
    return () => window.clearTimeout(first);
  }, [load, refreshKernel, active]);

  // A different notebook is a different question: neither the last one's cells
  // nor the last one's failure describes it.
  const [opened, setOpened] = useState(`${scope}\u0000${path}`);
  if (opened !== `${scope}\u0000${path}`) {
    setOpened(`${scope}\u0000${path}`);
    setNb(undefined);
    setFailure(undefined);
    setRead(false);
  }

  /**
   * ADOPT WHAT AN EARLIER MOUNT COULD NOT SAVE. A cell whose write failed left
   * its text in the stash; without this, re-opening the notebook would show the
   * file's version and the edit would be gone with no trace. Claimed, so the
   * mount that failed can no longer clear or overwrite it.
   */
  useEffect(() => {
    const adopted = claimCellDrafts(scope, path, owner.current);
    if (adopted.size === 0) return;
    stash.current = new Map(adopted);
    setDrafts((current) => {
      const merged = new Map(current);
      // What is on screen wins: it is either the same text or newer.
      for (const [cellId, text] of adopted) if (!merged.has(cellId)) merged.set(cellId, text);
      return merged;
    });
  }, [scope, path]);

  const create = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      setNb(await api.notebookEdit(sessionId, path, { kind: "create" }));
      setFailure(undefined);
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
        // It reached the notebook, so it is no longer owed to anybody — unless
        // something newer was typed while this write was open, which the owner
        // guard and the equality check both have to respect.
        if (stash.current.get(cellId) === draft) forgetCellDraft(scope, path, cellId, owner.current);
        setNb(next);
        setProblem(undefined);
        return next;
      } catch (cause) {
        // THE CASE FLUSHING ALONE NEVER COVERED. The write failed, this
        // component may already be unmounted, and the stash is now the only
        // copy of the cell — it stays until a write lands or the cell is
        // re-saved from a later mount.
        setProblem(cause instanceof Error ? cause.message : "Could not save.");
        return undefined;
      }
    },
    [sessionId, path, drafts, nb, api, scope],
  );

  /** The latest saver, read by a timer that outlives the render that armed it.
   *  Written in an effect, not during render — the lint's rule, and the right one. */
  const saveCellRef = useRef(saveCell);
  useEffect(() => {
    saveCellRef.current = saveCell;
  }, [saveCell]);
  const edit = (cellId: string, source: string) => {
    setDrafts((current) => new Map(current).set(cellId, source));
    stash.current.set(cellId, source);
    /**
     * CLAIMED BEFORE IT IS WRITTEN. A cell whose previous mount saved it
     * successfully still has that mount's name on the key (ownership outlives
     * the text — see lib/editor-drafts.ts), and `claimCellDrafts` on arrival
     * only adopts the cells that were still holding something. Without this,
     * typing into such a cell would be refused by the guard and quietly not
     * stashed at all.
     */
    claimCellDraft(scope, path, cellId, owner.current);
    rememberCellDraft(scope, path, cellId, source, owner.current);
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
      {/* The shared address row (session/editor-chrome.tsx) — the notebook's
          kernel controls are what goes in its slot, and nothing else about the
          row differs from a code file's. The glyph names the VIEW: cells are
          what is unusual about this tab, not the extension. */}
      <EditorAddressRow path={path} icon={<NotebookIcon className="size-3.5 shrink-0 text-muted-foreground" />}>
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
      </EditorAddressRow>

      {problem && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-[0.6875rem] leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{problem}</span>
          {/conflict|changed on disk/i.test(problem) && (
            <Button size="xs" variant="outline" onClick={() => { setDrafts(new Map()); void load(); }}>Re-read</Button>
          )}
        </div>
      )}

      {/*
        FOUR STATES, AND THEY ARE NOT INTERCHANGEABLE: still reading, the file
        is not there, the read failed, the notebook is open. A notebook already
        on screen outranks a failed re-read — its cells stay, with the banner
        above them — so only a surface with nothing to show falls through to a
        panel. Create is offered by ONE branch, and only for the engine's own
        "no such file".
      */}
      {failure && nb && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-[0.6875rem] leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {failure.kind === "missing" ? "This notebook is no longer in the workspace." : failure.message}
          </span>
          <Button size="xs" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {nb ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <InsertBar onInsert={(type) => void structural({ kind: "insert", after: -1, source: "", cellType: type })} />
          {cells.map((cell) => (
            <div key={cell.id}>
              <Cell
                cell={cell}
                count={cells.length}
                draft={drafts.get(cell.id)}
                running={running.has(cell.id) || running.has("*")}
                sessionId={sessionId}
                onEdit={(source) => edit(cell.id, source)}
                onRun={() => void run(cell.id)}
                onRunAll={() => void run()}
                onInsert={(where) =>
                  // ABOVE IS `after: index - 1`, which is -1 at the top — the
                  // same number the strip above the first cell already sends.
                  void structural({ kind: "insert", after: where === "above" ? cell.index - 1 : cell.id, source: "", cellType: "code" })
                }
                onMove={(to) => void structural({ kind: "move", cellId: cell.id, to })}
                onClearOutputs={() => void structural({ kind: "clearOutputs", cellId: cell.id })}
                onDelete={() => void structural({ kind: "delete", cellId: cell.id })}
                onType={(type) => void structural({ kind: "set", cellId: cell.id, cellType: type })}
                {...(onOpenImage ? { onOpenImage } : {})}
              />
              <InsertBar onInsert={(type) => void structural({ kind: "insert", after: cell.id, source: "", cellType: type })} />
            </div>
          ))}
        </div>
      ) : failure?.kind === "missing" ? (
        <PanelEmpty icon={<NotebookIcon />} title="No notebook here yet">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()} className="mt-2">
            {busy ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />} Create {path.slice(cut + 1)}
          </Button>
        </PanelEmpty>
      ) : failure ? (
        /**
         * THE READ FAILED, AND THE FILE IS PRESUMED TO BE THERE. No Create:
         * the engine did not say the notebook is absent, it said it could not
         * answer — and offering to make one over a file nobody has read is the
         * bug this branch exists to prevent.
         */
        <PanelEmpty icon={<TriangleAlertIcon />} title="Could not read this notebook">
          <span className="block max-w-prose text-balance">{failure.message}</span>
          <Button size="sm" variant="outline" onClick={() => void load()} className="mt-3">
            <RotateCwIcon className="size-3" /> Retry
          </Button>
        </PanelEmpty>
      ) : (
        <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground">
          <Spinner className="size-3" /> {read ? "reading…" : "opening…"}
        </p>
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

/**
 * THE CELL'S OWN MENU — every verb on it is a callback the cell already wires
 * to a VISIBLE control, so right-click reaches the same run, the same delete,
 * the same type toggle the buttons do. Nothing here is a second write path.
 *
 * ITS THREE NEW VERBS ARE NEW EVERYWHERE, not new here: Move up, Move down and
 * Clear outputs are `ds/notebook/edit` members the engine gained in this same
 * pass, for the reason those commits give — a client faking either one loses
 * the cell's id and the record of what it ran.
 *
 * MOVE IS DISABLED AT THE ENDS rather than clamped, matching the engine, which
 * refuses an out-of-range `to` precisely so a caller's broken disabled state
 * shows up instead of silently doing nothing.
 *
 * DELETE IS THE ONE DESTRUCTIVE ITEM in this app's menus so far, and it earns
 * the colour the primitive carries: it is the only row here that throws work
 * away, and the button it mirrors (`Trash2Icon`, `hover:text-destructive`)
 * already says so.
 */
function CellMenu({
  cell, count, source, collapsed, running, onRun, onRunAll, onInsert, onMove, onClearOutputs, onDelete, onType, onCollapse, children,
}: {
  cell: NotebookCell;
  count: number;
  /** The DRAFT if there is one — copying must give you what is on screen. */
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
      {/* `w-auto` because the primitive sizes to `--anchor-width`, which a
          context menu's cursor-point anchor reports as zero — so the popup is
          pinned at `min-w-40` and an item as long as "Insert markdown below"
          wraps. Per-surface rather than in the shared primitive, which other
          menus in this same pass are editing. */}
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
        {/* TWO ITEMS, AND BOTH MAKE A CODE CELL. The type is deliberately not
            offered here: the hover strip between every pair of cells already
            gives both types in place, with one click and no menu — and a
            markdown-above/markdown-below pair would double this list to say
            what the strip says better. A cell inserted as the wrong type is
            one "Change to Markdown" away, three rows down. */}
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
  /** How many cells the notebook has — the whole of what the menu needs to
   *  know whether Move down is the bottom cell's no-op. */
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
    </CellMenu>
  );
}
