"use client";

/**
 * THE EDITOR — one persistent surface, with the tree beside the file.
 *
 * WHY THIS REPLACED A PANEL TAB PER FILE. The panel's strip is where you keep
 * the things you are working WITH: the diff, the issues, the browser. Files
 * arrive in a different order of magnitude — you click nine of them to find one
 * — and minting a top-level tab for each meant that browsing a repository
 * pushed Diff and Issues off the edge of the strip. Opening a file cost you the
 * surfaces you had arranged. So files moved down a level: ONE Editor tab, which
 * holds its own strip, and the panel's strip goes back to holding surfaces.
 *
 * WHAT THIS IS NOT. It is not an IDE and it does not want to be: no language
 * server, no symbols, no find-in-project, no second tokenizer. The editing is
 * the same textarea-over-Shiki the file view always had (see
 * session/overlay-editor.tsx and session/file-view-surface.tsx), and the tree is
 * the same FilesSurface that was already a tab. What is new is only the
 * ARRANGEMENT: tree and file side by side, files as inner tabs, and a preview
 * slot so browsing does not accumulate.
 *
 * THE SPECIALISED VIEWS COME WITH IT. A notebook still opens as cells, a CSV as
 * a grid, a PDF as a document — they were file tabs before and they are file
 * tabs here, drawn by the same three surfaces. The Editor is where a file is
 * open, not what it looks like.
 */

import { useCallback, useRef, useState } from "react";
import { FileIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import {
  activateEditorFile,
  activeEditorFile,
  closeEditorFile,
  editorFileForPath,
  editorPaths,
  openInEditor,
  pinEditorFile,
  setExplorerOpen,
  type EditorState,
  type EditorViewState,
  type OpenIntent,
} from "@/lib/editor-workspace";
import { discardDraft, draftScope } from "@/lib/editor-drafts";
import { FileKindIcon } from "@/components/session/file-icon";
import { FilesSurface } from "@/components/session/files-surface";
import { FileViewSurface } from "@/components/session/file-view-surface";
import { NotebookSurface } from "@/components/session/notebook-surface";
import { PdfSurface } from "@/components/session/pdf-surface";
import { TableSurface } from "@/components/session/table-surface";
import { PanelEmpty } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

/** How wide the tree is. Narrow on purpose — the panel's own floor is 384px,
 *  and the file has to stay readable at that width or the split is a lie. */
const EXPLORER_WIDTH = "13rem";

/** What the strip's dot means. `clean` never appears — it is the absence. */
type SaveState = "saving" | "problem";

export function EditorSurface({
  state,
  onState,
  sessionId,
  projectId,
  hostId,
  active,
  dataScience = false,
  onOpenImage,
}: {
  state: EditorState;
  /** Updates go through the cockpit, which owns the state and persists it —
   *  the same shape the panel's own tabs use. */
  onState: (next: (current: EditorState) => EditorState) => void;
  sessionId?: string;
  projectId?: string;
  /** WHICH MAC these files live on — see `FileViewSurface`'s own note. */
  hostId?: string;
  active?: TurnState;
  dataScience?: boolean;
  onOpenImage?: (attachmentId: string) => void;
}) {
  /**
   * WHERE EACH FILE WAS LEFT, for as long as this Editor is on screen.
   *
   * A ref rather than state: nothing here renders from it, and re-rendering the
   * strip on every caret move would be a keystroke's worth of work per
   * keystroke. Not persisted either — see `EditorViewState`.
   */
  const views = useRef(new Map<string, EditorViewState>());
  /**
   * WHICH FILES HAVE UNSAVED WORK — kept HERE rather than in the file surface,
   * because the file surface is unmounted the moment you switch away and its
   * last write lands after that. The surface reports through a callback the
   * coordinator holds, so the dot goes clean when the flush finally answers.
   */
  const [saving, setSaving] = useState<ReadonlyMap<string, SaveState>>(new Map());
  /** A file whose save was REFUSED and whose close would therefore discard
   *  text. Closing it takes a second, deliberate click. */
  const [confirming, setConfirming] = useState<string>();
  /**
   * Files that are gone from the strip. A write that answers after a close must
   * not put a dot back on a tab that no longer exists — which would then show
   * up the moment somebody re-opened that path.
   */
  const closed = useRef(new Set<string>());
  /**
   * CLOSING A FILE MID-WRITE DOES NOT CLOSE IT YET.
   *
   * The write is still open and can still be REFUSED, and a tab that vanished a
   * moment before its save failed is a tab that took the only warning with it.
   * So the close is held: the tab stays, wearing its saving dot, and is removed
   * when the write lands. If it fails instead, the hold is dropped and the tab
   * stays with a red dot — which then takes the deliberate second click, the
   * same as any other refused file. The text itself is safe either way
   * (lib/editor-drafts.ts); this is about not lying in the strip.
   */
  const closingWhenClean = useRef(new Set<string>());

  const file = activeEditorFile(state);
  const open = editorPaths(state);
  /** Which checkout the unsaved text belongs to — the same key the file
   *  surface stashes under. */
  const scope = draftScope(hostId, sessionId, projectId);

  const openFile = useCallback(
    (path: string, intent: OpenIntent) => {
      closed.current.delete(path);
      closingWhenClean.current.delete(path);
      onState((current) => openInEditor(current, editorFileForPath(path, dataScience), intent));
    },
    [onState, dataScience],
  );

  /** Take the tab away and stop tracking it. The three ways a file leaves the
   *  strip all end here. */
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
      // A REFUSED save means this text reached nothing but the box. Closing
      // discards it, so it takes a second, deliberate click — and only then is
      // the stash thrown away with the tab.
      if (status === "problem") {
        if (confirming !== path) {
          setConfirming(path);
          return;
        }
        discardDraft(scope, path);
        forget(path);
        return;
      }
      // Still writing: held until the write answers — see `closingWhenClean`.
      if (status === "saving") {
        closingWhenClean.current.add(path);
        return;
      }
      forget(path);
    },
    [saving, confirming, forget, scope],
  );

  const reportSave = useCallback(
    (path: string, next: "clean" | SaveState) => {
      if (closed.current.has(path)) return;
      if (next === "clean" && closingWhenClean.current.has(path)) {
        // The write everybody was waiting on landed. NOW the tab can go.
        forget(path);
        return;
      }
      /**
       * It failed instead. The close is dropped and the tab stays — and it
       * arms the discard affordance, because otherwise a person who pressed
       * close a second ago is looking at a tab that did not go away with no
       * word about why. Armed rather than acted on: the text is only in the
       * stash now, and throwing it out stays a deliberate second click.
       */
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

  /** One mounted file body. Keyed by session AND path so switching sessions
   *  cannot leave one session's text under another session's tab. */
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
      />
    );
  };

  return (
    <div className="flex h-full min-h-0">
      {/**
       * THE TREE, IN ITS OWN SCROLLER. `FilesSurface` draws a `min-h-full`
       * column with a sticky foot, so it needs a box that scrolls — the same
       * one it had as a panel tab, just narrower.
       */}
      {state.explorerOpen && (
        <div
          /* No label of its own: the tree inside is the labelled thing
             (`role="tree"`, "Workspace files"), and a name on a generic box
             around it is a name screen readers cannot use anyway. */
          style={{ width: EXPLORER_WIDTH }}
          className="flex shrink-0 flex-col overflow-y-auto border-r border-border"
        >
          <FilesSurface
            {...(sessionId ? { sessionId } : {})}
            {...(projectId ? { projectId } : {})}
            openPaths={open}
            onOpenFile={openFile}
            {...(active ? { active } : {})}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/**
         * THE INNER STRIP. Same vocabulary as the panel's own — a 28px row of
         * rounded chips, close on hover, middle-click closes — because it is the
         * same gesture one level down, and a second dialect of "tab" inside the
         * first would be the thing that made this feel like an app inside an app.
         */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
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
                    "group/file relative flex h-7 min-w-0 max-w-44 shrink-0 items-center rounded-md px-1.5 text-xs transition-colors",
                    on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => onState((current) => activateEditorFile(current, entry.path))}
                    // Double-clicking the preview tab is the other way to say
                    // "keep this", and the one every editor has taught.
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
                    {/* ITALIC IS THE PREVIEW, the same signal every editor with
                        a preview slot uses — it says "this tab is on loan". */}
                    <span className={cn("truncate", !entry.pinned && "italic")}>{name}</span>
                  </button>
                  {/* UNSAVED IS A DOT, and it sits where the close button goes
                      so the two never both take width. Red when a save was
                      REFUSED, because then the text exists only in the box. */}
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
