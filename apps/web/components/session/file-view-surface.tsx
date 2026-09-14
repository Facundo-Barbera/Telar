"use client";

/**
 * ONE FILE, OPEN IN THE PANEL — AND EDITABLE.
 *
 * WHY A TAB PER FILE, and not a preview pane under the tree. t3 code splits its
 * Files panel in two — tree above, preview below — because its panel is wide. Ours
 * has a floor of 320px, and a split there gives you a tree you cannot read above a
 * file you cannot read. This panel already has a grammar for "a thing I opened
 * that is not a fold over the session": one tab per browser page. A file is the
 * same kind of thing, so it gets the same treatment — `file:<path>` beside
 * `browser:<id>` — which means several can be open, each closes on its own, and
 * the arrangement survives a reload like every other tab.
 *
 * A TEXTAREA OVER THE HIGHLIGHTED LAYER, which is the whole trick and the reason
 * editing did not cost the design. The coloured lines stay exactly as they were;
 * a transparent-text textarea sits on top of them, sharing font, size,
 * line-height, padding and tab size, so its invisible glyphs land on the coloured
 * ones and its caret lands where you would expect. Monaco would have brought its
 * own DOM, its own scrollbars and its own TOKENIZER — meaning code in this panel
 * would be coloured by a different engine than code in the transcript, which is
 * the seam this cockpit keeps closing. t3 code uses neither: it renders a private
 * component library that also draws its diffs.
 *
 * WHAT WE COPIED FROM t3 AND WHAT WE DID NOT. Its editor is editable with no edit
 * mode (no pencil, no toggle) and autosaves on a 500ms debounce, flushing on
 * close — all three are right and all three are here (lib/save-coordinator.ts).
 * What it does NOT do is check for conflicts: its `persist` sends the contents and
 * the write wins. Fine in an app where nothing else writes the file; not fine
 * here, where an AGENT may be writing it mid-turn. So every save carries the hash
 * the read returned and the engine refuses when disk has moved.
 *
 * READ-ONLY WHERE IT MUST BE, and it says which: a binary file has no text to
 * edit, and a TRUNCATED read is holding a prefix, so saving it would delete
 * everything past the cut.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BoldIcon,
  CodeIcon,
  EyeIcon,
  FileIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  PencilIcon,
  QuoteIcon,
  RotateCwIcon,
  StrikethroughIcon,
  TriangleAlertIcon,
  WrapTextIcon,
} from "lucide-react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { claimDraft, draftScope, forgetDraft, newDraftOwner, rememberDraft } from "@/lib/editor-drafts";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import type { EditorViewState } from "@/lib/editor-workspace";
import { fileKind } from "@/lib/file-kinds";
import { createFileWriter, type FileWriter } from "@/lib/file-writer";
import { detectNewline, withNewline } from "@/lib/line-endings";
import {
  isProseFile,
  NOWRAP_CLASS,
  serverWrapLinesSnapshot,
  subscribeWrapLines,
  WRAP_CLASS,
  wrapLinesSnapshot,
  writeWrapLines,
} from "@/lib/editor-wrap";
import { rawFileUrl } from "@/lib/file-urls";
import { carryTokens, highlight, MAX_HIGHLIGHT_BYTES, type HighlightedLine } from "@/lib/highlight";
import { applyMarkdownEdit, type MarkdownEditAction } from "@/lib/markdown-edit";
import { SaveCoordinator } from "@/lib/save-coordinator";
import { EditorAddressRow } from "@/components/session/editor-chrome";
import { FileKindIcon } from "@/components/session/file-icon";
/**
 * THE TYPE GEOMETRY OF THE TWO STACKED LAYERS, AND THE LAYER ITSELF — from the
 * editor a notebook cell also uses, because both are one invariant and it was
 * written down twice.
 *
 * IDENTICAL ON BOTH, OR THE CARET DRIFTS: every property in `CODE_GEOMETRY`
 * decides where a glyph lands, so changing one on the textarea and not on the
 * `<pre>` slides the invisible text out from under the coloured text, a
 * character at a time, further with every line. `CodeLines` is the same
 * invariant seen down the other axis — one line box per source line, so a
 * blank line cannot collapse and take the caret's row with it.
 */
import { CODE_FONT_SIZE, CODE_GEOMETRY, CodeLines } from "@/components/session/overlay-editor";
import { fileReference, type TelarReference } from "@/lib/drag-reference";
import { useWorkspaceFileMenu, workspaceFilePath, type WorkspaceFileMenu } from "@/lib/workspace-open";
import { OpenerIcon } from "@/components/session/opener-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ui/message";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * THE ENGINE THIS FILE BELONGS TO, PINNED — not "whichever engine the address
 * bar names when the request finally goes out".
 *
 * The default client resolves the host FROM THE PATHNAME AT CALL TIME
 * (lib/hosts/client.ts `pathnameFetcher`), which is right for a screen that is
 * only ever about the Mac you are looking at. This editor is not that: a write
 * is debounced, retried and FLUSHED ON UNMOUNT, so it can leave after you have
 * navigated to a session on another host — and a session id minted on one
 * engine is a perfectly valid-looking id on another. Pinning the fetcher at
 * mount means every read, write and late retry for this file goes to the Mac
 * the file was opened on, whatever the address bar says by then.
 */
function engineFor(hostId: string | undefined) {
  return createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
}

/**
 * How long after the last keystroke a save goes out.
 *
 * t3 code's number, and it is a good one: long enough that a burst of typing is
 * one write rather than forty, short enough that "did that save?" never becomes a
 * question. ⌘S skips it.
 */
const SAVE_DEBOUNCE_MS = 500;

/** Bytes, the way a person reads them. Not for accounting — for deciding whether
 *  what you are looking at is the whole thing. */
function size(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * What the engine said when it would not write.
 *
 * FOUR SENTENCES, NOT ONE, because they need four different responses — the same
 * reason the GitHub surface spells out its four ways of being unavailable. Only
 * `conflict` is recoverable by re-reading, and only it offers the button.
 */
const REFUSAL: Record<string, string> = {
  conflict: "This file changed on disk while you were editing — most likely the agent wrote it. Your text has not been saved.",
  not_found: "This file is no longer there. It was moved or deleted while you had it open.",
  binary: "The engine reports this file as binary, so there is no text to save back.",
  too_large: "This file is too large for the panel to save safely — it was only partly read, and writing it back would drop the rest.",
};

/**
 * The markdown toolbar's buttons, in the order writing uses them. The math
 * lives in lib/markdown-edit.ts (pure, tested); each button here is only
 * "read the selection, apply, write both halves back".
 */
const MARKDOWN_ACTIONS: { action: MarkdownEditAction; label: string; icon: typeof BoldIcon }[] = [
  { action: "bold", label: "Bold", icon: BoldIcon },
  { action: "italic", label: "Italic", icon: ItalicIcon },
  { action: "strike", label: "Strikethrough", icon: StrikethroughIcon },
  { action: "code", label: "Inline code", icon: CodeIcon },
  { action: "link", label: "Link", icon: LinkIcon },
  { action: "heading", label: "Heading", icon: Heading2Icon },
  { action: "bullet", label: "Bulleted list", icon: ListIcon },
  { action: "quote", label: "Quote", icon: QuoteIcon },
];

/**
 * THIS FILE'S OWN MENU — written once and hung on both of the surface's two
 * right-clickable places, because the address row and the body are ONE
 * surface: they are about the same file, and offering different verbs
 * depending on whether you clicked above or below the hairline would be two
 * answers to one question.
 *
 * NOT ON THE TEXTAREA. Right-clicking inside the box you are typing in must
 * still bring up the browser's own edit menu — cut, paste, look up, spelling —
 * and replacing that with "Re-read from disk" would take away something a
 * person uses constantly to add something they use rarely. The textarea stops
 * the event; see its `onContextMenu`.
 *
 * THE VIEW CONTROLS ARE THE HEADER'S OWN, in the shapes a menu has for them: a
 * checkbox for wrap (it is on or off) and a radio pair for markdown (it is one
 * or the other). Both write through the same call the visible control does.
 */
function FileMenuItems({
  path,
  absolute,
  files,
  onReread,
  wrap,
  onWrap,
  markdown,
  source,
  onSource,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  path: string;
  absolute?: string | undefined;
  files: WorkspaceFileMenu;
  onReread: () => void;
  /** Absent where wrapping would change nothing on screen — a binary, or
   *  markdown being rendered rather than edited. */
  wrap?: { on: boolean } | undefined;
  onWrap: (on: boolean) => void;
  /** Absent unless this file has both views to choose between. */
  markdown: boolean;
  source: boolean;
  onSource: (source: boolean) => void;
  onInsertReference?: ((reference: TelarReference) => void) | undefined;
  /** Open this file in a SECOND Editor beside this one (#322). Absent hides
   *  the row. */
  onOpenInNewPanelTab?: ((path: string) => void) | undefined;
}) {
  return (
    <>
      {/* FIRST, because it is the only row here that opens anything — the rest
          copy, re-read or change how this view draws. */}
      {onOpenInNewPanelTab && (
        <>
          <ContextMenuItem onClick={() => onOpenInNewPanelTab(path)}>Open in a new panel tab</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {absolute && <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute)}>Copy path</ContextMenuItem>}
      <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>
      {files.reveal && files.open && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => files.reveal!(path, "file")}>Reveal in Finder</ContextMenuItem>
          <ContextMenuItem onClick={() => files.open!(path, "file")}>
            <OpenerIcon icon={files.openIcon} iconDataUrl={files.openIconDataUrl} />
            {files.openLabel}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onReread}>Re-read from disk</ContextMenuItem>
      {wrap && (
        <ContextMenuCheckboxItem checked={wrap.on} onCheckedChange={onWrap}>
          Wrap lines
        </ContextMenuCheckboxItem>
      )}
      {markdown && (
        <ContextMenuRadioGroup value={source ? "source" : "rendered"} onValueChange={(value) => onSource(value === "source")}>
          <ContextMenuRadioItem value="rendered">Rendered</ContextMenuRadioItem>
          <ContextMenuRadioItem value="source">Source</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      )}
      {onInsertReference && (
        <>
          <ContextMenuSeparator />
          {/* The SAME payload the address row's drag carries. */}
          <ContextMenuItem onClick={() => onInsertReference(fileReference(path))}>Insert into composer as a reference</ContextMenuItem>
        </>
      )}
    </>
  );
}

export function FileViewSurface({
  path,
  sessionId,
  projectId,
  hostId,
  /** A turn settling is the moment the file on disk may have changed. */
  active,
  onSaveState,
  onEdit,
  readView,
  onView,
  workspacePath,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  path: string;
  sessionId?: string;
  projectId?: string;
  /** WHICH MAC this file lives on. Pins the engine client (see `engineFor`) and
   *  keys the unsaved-text stash, because two engines mint session ids
   *  independently and can mint the same one. */
  hostId?: string;
  active?: TurnState;
  /**
   * WHAT THE SAVER IS DOING, for a strip that outlives this component.
   *
   * REPORTED FROM THE COORDINATOR'S OWN CALLBACKS, not from an effect on the
   * state below — and that is the whole reason it exists. Closing a file
   * FLUSHES rather than cancels (`SaveCoordinator.dispose`), so the write that
   * matters most is the one that lands AFTER this component has gone. A
   * setState then is dropped on the floor; a call to the parent's callback is
   * not, because the Editor around it is still mounted. So the dot in the strip
   * goes clean when the flush lands, and stays red if it was refused.
   */
  onSaveState?: (state: "clean" | "saving" | "problem") => void;
  /** The first keystroke. The Editor pins the file on it, which is what makes
   *  replacing the preview slot safe (lib/editor-workspace.ts). */
  onEdit?: () => void;
  /**
   * Where this file was left: caret, selection and scroll. Only the active file
   * is mounted, so switching away and back is a REMOUNT — without this every
   * return trip lands at the top of a file you were reading at line 400.
   *
   * A FUNCTION, NOT A VALUE, because the Editor keeps these in a Map behind a
   * ref (nothing renders from them) and reading a ref during render is exactly
   * the impurity React's own lint rule forbids. This is called once, from the
   * effect that restores.
   */
  readView?: () => EditorViewState | undefined;
  onView?: (view: EditorViewState) => void;
  /**
   * THE CHECKOUT `path` IS RELATIVE TO, when the caller knows it — the Editor
   * does, from the tree's own listing. Without it the menu cannot name this
   * file on disk, so "Copy path", "Reveal in Finder" and "Open in <app>" are
   * absent rather than offered and broken. A `file:` panel tab restored by an
   * older layout (right-panel.tsx) is the case that has none.
   */
  workspacePath?: string;
  /** Put a reference to this file in the message being written. Absent until a
   *  composer is listening, and the item is absent with it. */
  onInsertReference?: (reference: TelarReference) => void;
  /** Open this file in a SECOND Editor (#322) — offered by this file's own
   *  menu, beside the tree's row menu that offers the same thing. */
  onOpenInNewPanelTab?: (path: string) => void;
}) {
  const [file, setFile] = useState<WorkspaceFile>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  /**
   * KEYED BY THE TEXT IT BELONGS TO, not just stored.
   *
   * Highlighting is async, so a result can arrive after the viewer has moved on —
   * a refresh that found new bytes, a keystroke, or a tab now showing a different
   * file. Carrying the text the tokens were made from turns "is this stale?" into
   * a comparison at render instead of a cleanup that has to fire in time.
   */
  const [tokenised, setTokenised] = useState<{ of: string; lines: HighlightedLine[] }>();
  /** What is in the box. Diverges from `file.text` the moment you type, and is
   *  what gets saved. */
  const [draft, setDraft] = useState<string>();
  /**
   * THE WRITER WHOSE FIRST READ HAS LANDED — the gate on building the saver, and
   * NOTHING ELSE.
   *
   * It used to be the baseline hash itself, and that was the false-conflict bug:
   * the hash advances on every successful write, so the saver was torn down and
   * rebuilt by its own saves, and the rebuilt one carried a hash that went stale
   * the moment the outgoing write landed. The hash now lives in the writer (see
   * lib/file-writer.ts), which outlives every saver; this only says "there is
   * one to write against", and it changes once per file rather than once per
   * keystroke-burst.
   */
  const [readied, setReadied] = useState<FileWriter>();
  /** How many times this file has been deliberately re-read over — the refresh
   *  button, or "Re-read from disk" after a refusal. See the effect that
   *  restarts the saver on it. */
  const [discarded, setDiscarded] = useState(0);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ refused: boolean; reason: string }>();
  const kind = fileKind(path);
  /**
   * MARKDOWN RENDERS BY DEFAULT. A .md file opened from the tree — or put in
   * front of you by the agent's display tool — is a document to READ; the
   * source is one toggle away and everything about editing (the saver, the
   * conflict hash, ⌘S) is shared with it, so switching costs nothing. `source`
   * rather than `preview` so the boolean's false state is the default state.
   */
  const markdown = kind.lang === "markdown";
  /**
   * Soft wrap, prose only, off by default — lib/editor-wrap.ts. Read through
   * the store's subscription so hydration agrees and open editors flip
   * together.
   */
  const prose = isProseFile(kind);
  const wrap = useSyncExternalStore(subscribeWrapLines, wrapLinesSnapshot, serverWrapLinesSnapshot);
  const wrapping = prose && wrap;
  const wrapClass = wrapping ? WRAP_CLASS : NOWRAP_CLASS;
  const [source, setSource] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** The box the code scrolls in — the other half of "where I left this file". */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The two callbacks the SAVER holds, behind refs.
   *
   * The coordinator is built once per file identity and keeps whatever closures
   * it was built with — including after this component unmounts, when its flush
   * finally answers. A ref is what lets that late answer reach the CURRENT
   * parent callback rather than the one that existed when the file was opened.
   */
  const saveStateRef = useRef(onSaveState);
  useEffect(() => {
    saveStateRef.current = onSaveState;
  }, [onSaveState]);
  /**
   * The newest text — one of the two things the stash needs (the other is the
   * hash it is owed against, which the writer holds), readable from a callback
   * that outlives the render that made it. A ref, because a coordinator callback
   * answering after unmount cannot read state and must not read a closure from
   * the render that opened the file.
   */
  const latest = useRef<string>("");
  /** Which checkout on which Mac this path is in. Two sessions can hold the
   *  same path with different bytes, and two engines can mint the same session
   *  id — either would hand one editor another's unsaved text. */
  const scope = draftScope(hostId, sessionId, projectId);
  /**
   * WHO THIS MOUNT IS, for the stash.
   *
   * A write outlives the mount that started it, so the editor you switched away
   * from and the one you re-opened overlap in time. This token is what lets the
   * store drop the old one's late answer instead of letting it clear — or
   * overwrite with older text — what you have typed since. Claimed on adoption,
   * in `load`.
   */
  const owner = useRef(newDraftOwner());
  /** The engine this file belongs to, pinned for the life of the mount so a
   *  flush that leaves after a navigation still goes to the right Mac. */
  const api = useMemo(() => engineFor(hostId), [hostId]);
  /**
   * THE ONE THING THAT KNOWS WHAT IS ON DISK — and it outlives every save
   * coordinator built above it, which is the whole point (lib/file-writer.ts).
   *
   * Re-made only when the FILE changes. A write advancing the hash must not
   * re-make it, or the next write goes out carrying what disk looked like
   * before the last one landed and the engine correctly refuses it as a
   * conflict — with a change that was nobody's but the person typing.
   */
  const writer = useMemo(
    () =>
      createFileWriter({
        send: async (text, expected) => {
          const result = sessionId
            ? await api.writeSessionFile(sessionId, path, text, expected)
            : await api.writeProjectFile(projectId!, path, text, expected);
          if (!result.written) return { written: false, refusal: result.refusal };
          /**
           * AND THE HEADER HAS TO FOLLOW. `file` is what the last READ returned,
           * so without this the size stays at whatever the file was when it was
           * opened — a saved file reading "11 B" beside 41 bytes of text, which I
           * only noticed because it sat next to a conflict banner and made the
           * banner look wrong too.
           */
          setFile((known) => (known ? { ...known, ...result.file } : known));
          return { written: true, sha256: result.file.sha256 };
        },
        describe: (cause) => (cause instanceof EngineApiError ? cause.message : "The save could not be sent."),
      }),
    [api, sessionId, projectId, path],
  );
  /** Restored once — and only once it has actually LANDED (see the effect):
   *  doing it again would fight the caret you just moved. */
  const restored = useRef(false);
  const readViewRef = useRef(readView);
  useEffect(() => {
    readViewRef.current = readView;
  }, [readView]);

  /**
   * Read the file — and prefer UNSAVED TEXT over what is on disk.
   *
   * `discard` is what tells the two kinds of read apart. A mount (or a settled
   * turn) must adopt whatever this file was left holding: switching files
   * unmounts this component, so the stash in lib/editor-drafts.ts is the only
   * copy of an edit that could not be written, and reading over it would show
   * you the agent's version as though you had never typed. Pressing "Re-read
   * from disk" — or the refresh button — is the opposite request, and says so.
   *
   * THE STASHED BASELINE COMES WITH THE STASHED TEXT. The hash a write carries
   * is what makes the engine refuse to overwrite what it never showed you;
   * adopting the text but writing against the FRESH read's hash would turn a
   * refusal into a silent win over whatever changed the file.
   */
  const load = useCallback(
    async (discard = false) => {
      if (!sessionId && !projectId) return;
      /**
       * WHAT WE HAD ALREADY WRITTEN WHEN THIS READ WENT OUT.
       *
       * A settled turn re-reads (the effect below), and that read can be issued
       * a moment BEFORE an autosave lands — so it answers with the bytes and the
       * hash from before the save. Adopting it would put the text back to what
       * it was a second ago and re-baseline the next write against a hash disk
       * has already moved past, which the engine then refuses as a conflict. So
       * a read that our own write has overtaken is simply dropped: it is not
       * news, it is an echo.
       */
      const before = writer.writes;
      try {
        const read = sessionId ? await api.sessionFile(sessionId, path) : await api.projectFile(projectId!, path);
        if (!discard && writer.writes !== before) return read.file;
        setFile(read.file);
        /**
         * CLAIMED FIRST, whichever kind of read this is, and not merely read.
         * Taking the key is what makes the previous mount's answer harmless:
         * from here its `forgetDraft` and its `rememberDraft` are dropped, so a
         * write it started before you switched away cannot clear — or overwrite
         * with its older text — what you are about to type. It also has to
         * happen before the discard below, or "re-read from disk" would fail to
         * delete a stash somebody else still owns and then adopt it anyway.
         */
        const claimed = read.file.binary ? undefined : claimDraft(scope, path, owner.current);
        if (discard) forgetDraft(scope, path, owner.current);
        const stashed = discard ? undefined : claimed;
        /**
         * THE EDITOR WORKS IN LF, WHATEVER THE FILE USES.
         *
         * Not a preference — a textarea's value is line-break normalised by the
         * HTML spec, so the first keystroke would hand back LF for the whole
         * file anyway and quietly rewrite every line ending. Normalising the
         * READ too is what keeps the two layers holding the same text, and the
         * write puts the file's own endings back (lib/line-endings.ts).
         */
        const newline = read.file.binary ? "\n" : detectNewline(read.file.text);
        const onDisk = read.file.binary ? undefined : withNewline(read.file.text, "\n");
        const text = read.file.binary ? undefined : (stashed?.text ?? onDisk);
        const hash = read.file.binary ? undefined : (stashed?.baseline ?? read.file.sha256);
        latest.current = text ?? "";
        writer.rebase({ sha256: hash, newline });
        /**
         * A DISCARD RESTARTS THE SAVER RATHER THAN REPLACING IT — see the effect
         * that acts on this. "Re-read from disk" is the way out of a refusal,
         * and a refusal STOPS the coordinator, so something has to tell it the
         * argument is over. That used to be the baseline changing, which rebuilt
         * the coordinator — and that rebuild is the false-conflict bug, so the
         * restart is said out loud instead.
         */
        if (discard) setDiscarded((count) => count + 1);
        setDraft(text);
        setReadied(hash ? writer : undefined);
        setProblem(stashed?.problem);
        setPending(Boolean(stashed) && !stashed?.problem);
        // The strip's dot says the same thing this header does — including that
        // a re-opened file is STILL unsaved.
        saveStateRef.current?.(stashed?.problem ? "problem" : stashed ? "saving" : "clean");
        setError(undefined);
        return read.file;
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
        return undefined;
      }
    },
    [sessionId, projectId, path, scope, api, writer],
  );

  useEffect(() => {
    // Deferred, like every other read in this panel: a synchronous
    // fetch-and-setState on mount is a cascading render.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  /**
   * EDITABLE ONLY WHERE SAVING COULD NOT DESTROY SOMETHING.
   *
   * A truncated read is holding a prefix — saving it deletes the rest of the file.
   * The engine refuses that too, but a box you can type into and never save is
   * worse than one you cannot type into.
   */
  const editable = Boolean(file && !file.binary && !file.truncated && (sessionId || projectId));

  /**
   * ONE COORDINATOR PER OPEN FILE, and it is torn down with the tab.
   *
   * A ref rather than state: it is not rendered, and re-creating it on a keystroke
   * would reset the debounce it exists to hold.
   *
   * BUILT ONCE PER FILE, AND NOT ONCE PER SAVE. It used to be re-made whenever
   * the baseline hash changed — which is after every successful write, so the
   * coordinator was rebuilt by its own saves, mid-typing. Two of them then
   * overlapped: the outgoing one flushing its pending keystrokes on the way out,
   * and the new one re-armed from the stash carrying the hash from BEFORE that
   * flush. Whichever landed second was refused, and the panel said the file had
   * changed on disk about a change that was only ever the person typing. The
   * hash it sends now comes from the writer, which outlives all of this.
   */
  const saverRef = useRef<SaveCoordinator | null>(null);
  useEffect(() => {
    if (!editable || readied !== writer) return;
    const saver = new SaveCoordinator({
      debounceMs: SAVE_DEBOUNCE_MS,
      persist: (text) => writer.persist(text),
      onPending: (value) => {
        setPending(value);
        // Told to the strip as well as to this header — see `onSaveState`.
        saveStateRef.current?.(value ? "saving" : "clean");
      },
      /**
       * THE THREE OUTCOMES ALL MAINTAIN THE STASH, from inside the coordinator
       * rather than from a React effect — because the write that matters most
       * is the one that answers AFTER this component has been unmounted by a
       * switch or a close. A setState then is dropped on the floor; these are
       * not, and they are what decides whether the text is still owed to
       * somebody.
       */
      onSaved: (text) => {
        setProblem(undefined);
        // It reached disk. Anything still stashed would resurrect an older edit
        // the next time this file was opened.
        forgetDraft(scope, path, owner.current);
        // Except for text typed WHILE that write was open — the coordinator is
        // already saving it, and it must stay recoverable until it lands. Owed
        // against the hash that write PRODUCED, which is where the writer is now.
        const owed = writer.baseline;
        if (owed && latest.current !== text) rememberDraft(scope, path, { text: latest.current, baseline: owed }, owner.current);
      },
      onProblem: (outcome) => {
        const failure = { refused: outcome.status === "refused", reason: outcome.reason };
        setProblem(failure);
        // THE ONE THAT MADE THIS STORE NECESSARY. A refusal means the only copy
        // of this text is in the box; kept with the baseline it was edited
        // against — which a refusal leaves exactly where it was — so a re-opened
        // file is refused a second time rather than winning.
        const owed = writer.baseline;
        if (owed) rememberDraft(scope, path, { text: latest.current, baseline: owed, problem: failure }, owner.current);
        saveStateRef.current?.("problem");
      },
    });
    saverRef.current = saver;
    /**
     * TEXT ADOPTED FROM THE STASH IS STILL OWED TO DISK, so the new coordinator
     * is told about it. Without this, re-opening a file with unsaved text would
     * show it, mark it unsaved, and then never try again — a dot that means
     * nothing is on its way. A refused edit is attempted exactly once more here
     * and refused again if the file is still moved, which is the honest answer
     * rather than a retry loop (the coordinator stops itself after a refusal).
     */
    // Ours to re-arm only if this mount still holds the key — claimed in `load`.
    const stashed = claimDraft(scope, path, owner.current);
    if (stashed && stashed.baseline === writer.baseline) saver.change(stashed.text);
    return () => {
      // FLUSHES, not cancels — see `dispose`. Closing the tab a moment after
      // typing must not throw the last keystrokes away.
      saver.dispose();
      saverRef.current = null;
    };
    // `scope` is derived from sessionId/projectId, which the writer is keyed on —
    // it is listed so the stash key and the coordinator can never disagree.
  }, [editable, readied, writer, scope, path]);

  /**
   * A DELIBERATE RE-READ RESTARTS THE SAVER IN PLACE, rather than replacing it.
   *
   * Two things have to happen and only one of them is obvious. The obvious one:
   * a refusal STOPS the coordinator, and "Re-read from disk" is the way out of
   * a refusal, so it has to be startable again or the file is silently
   * unsaveable from then on. The other one is why this is not a rebuild — a
   * rebuild DISPOSES the old coordinator, and disposing FLUSHES rather than
   * cancels, so the text you just asked to throw away would be written straight
   * back over the version you asked to read. `resume` marks it saved instead,
   * which is what a discard means.
   *
   * Below the effect that assigns `saverRef`, deliberately: the compiler's
   * immutability rule forbids assigning a ref that an earlier hook already
   * closed over.
   */
  useEffect(() => {
    if (discarded === 0) return;
    saverRef.current?.resume(latest.current);
  }, [discarded]);

  /**
   * LINE NUMBERS AS A SEPARATE COLUMN, so selecting the text and copying it does
   * not carry them along. Split from the DRAFT rather than the file: the gutter
   * has to grow as you type or the numbers stop matching the lines.
   */
  const lines = useMemo(() => (draft === undefined ? [] : draft.split("\n")), [draft]);

  /**
   * HIGHLIGHT AFTER THE TEXT IS ALREADY ON SCREEN, never before it.
   *
   * The grammar is a lazy chunk and tokenising is real work, so the plain lines
   * paint first and the colours replace them a beat later. The other order — wait
   * for Shiki, then show anything — would trade a readable file now for a prettier
   * one soon, which is the wrong way round for a panel you opened to read
   * something. While TYPING this re-runs per keystroke, which is why the debounce
   * below exists: 60 tokenising passes a second is a jank machine.
   */
  useEffect(() => {
    if (draft === undefined) return;
    let cancelled = false;
    /**
     * RE-TOKENISED ON A DELAY, and a short one: the caret and the characters come
     * from the textarea and are never waiting on this, so the only thing lagging
     * is colour. 120ms is under the threshold where that reads as broken and far
     * above the cost of a keystroke.
     */
    const task = window.setTimeout(() => {
      void highlight(draft, kind.lang).then((result) => {
        if (!cancelled && result) setTokenised({ of: draft, lines: result });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [draft, kind.lang]);
  /**
   * The tokens for the text currently on screen — and, for the text it is one
   * keystroke behind, the tokens of every line that keystroke did not change.
   *
   * ALL-OR-NOTHING WAS THE FLICKER. This used to drop the whole answer the
   * moment `of` stopped matching, which repainted EVERY line of the file as
   * plain uncoloured text for the 120ms until Shiki answered again — so at
   * typing speed the file blinked monochrome continuously. Almost every line is
   * character-for-character unchanged and its colours are still right; only the
   * edited region genuinely has no tokens yet. See `carryTokens`.
   */
  const coloured = useMemo(() => (tokenised && draft !== undefined ? carryTokens(tokenised, draft) : undefined), [tokenised, draft]);

  /**
   * PUT THE READER BACK WHERE THEY WERE, once, when the text first arrives.
   *
   * Switching files in the Editor unmounts this component (only the active file
   * is mounted — the alternative is N open files each holding a read, a saver
   * and a re-read on every settled turn). So coming back is a fresh mount with
   * an empty textarea, and without this every return trip lands at line 1 of a
   * file you were reading at line 400.
   *
   * AFTER THE PAINT, not with it: the textarea has to be holding the text
   * before a selection range means anything, and the scroller has to have its
   * full height before a scrollTop does.
   */
  useEffect(() => {
    if (draft === undefined || restored.current) return;
    const where = readViewRef.current?.();
    if (!where) {
      // Nothing to put back is a finished restore, not a pending one.
      restored.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const area = textareaRef.current;
      const scroller = scrollerRef.current;
      // LATCHED WHERE IT LANDS, not where it is scheduled. An effect that
      // re-runs — the highlight arriving, a parent re-render — cancels this
      // frame, and a latch set at scheduling time would make that cancellation
      // permanent: the caret would silently never be restored.
      restored.current = true;
      // Clamped: the file may have been rewritten on disk since, and a range
      // past the end of the text throws the caret to the end rather than
      // failing loudly.
      if (area) area.setSelectionRange(Math.min(where.selectionStart, area.value.length), Math.min(where.selectionEnd, area.value.length));
      if (scroller) {
        scroller.scrollTop = where.scrollTop;
        scroller.scrollLeft = where.scrollLeft;
      }
    });
    return () => cancelAnimationFrame(frame);
    // Only the text. `readView` is an inline closure that changes every render
    // and is read through a ref for exactly that reason — as a dependency it
    // would re-run this effect constantly.
  }, [draft]);

  /** Where this file is, right now — handed up on every gesture that could
   *  have moved it, and cheap enough to do exactly that (the Editor writes it
   *  into a Map). */
  const rememberView = useCallback(() => {
    const area = textareaRef.current;
    if (!area || !onView) return;
    onView({
      selectionStart: area.selectionStart,
      selectionEnd: area.selectionEnd,
      scrollTop: scrollerRef.current?.scrollTop ?? 0,
      scrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    });
  }, [onView]);

  /**
   * One toolbar press: read the textarea's own selection, run the pure edit,
   * write text through the SAME two sinks a keystroke uses (draft + saver — a
   * third path would be a way to type that does not save), then put the
   * selection back where the edit says it lands. The selection write waits a
   * frame because React has to paint the new value first; setting a range
   * against the old text puts the caret in the wrong place on longer inserts.
   */
  /**
   * THE ONE WAY TEXT CHANGES IN THIS COMPONENT — box, toolbar, anything later.
   *
   * Three sinks, and all three are needed: the draft is what is on screen, the
   * coordinator is what reaches disk, and the stash is what survives this
   * component being unmounted before the coordinator finishes. A second path
   * that skipped the third would be a way to type that can still be lost.
   */
  const change = useCallback(
    (text: string) => {
      latest.current = text;
      setDraft(text);
      saverRef.current?.change(text);
      const owed = writer.baseline;
      if (owed) rememberDraft(scope, path, { text, baseline: owed }, owner.current);
    },
    [scope, path, writer],
  );

  const applyEdit = useCallback(
    (action: MarkdownEditAction) => {
      const area = textareaRef.current;
      if (!area || draft === undefined) return;
      const edit = applyMarkdownEdit(draft, area.selectionStart, area.selectionEnd, action);
      change(edit.text);
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      });
    },
    [draft, change],
  );

  const dirty = pending || Boolean(problem);
  /** What the header's refresh glyph does. Named so the menu fires the same
   *  callback rather than growing a second way to discard and re-read. */
  const reread = useCallback(() => {
    setRefreshing(true);
    // DISCARDS: see the button.
    void load(true).finally(() => setRefreshing(false));
  }, [load]);
  const files = useWorkspaceFileMenu({ workspacePath, hostId });
  const absolute = workspaceFilePath(workspacePath, path);
  /** The menu, written once for both places it hangs — see `FileMenuItems`. */
  const menu = (
    <FileMenuItems
      path={path}
      {...(absolute ? { absolute } : {})}
      files={files}
      onReread={reread}
      // Only where it would change what is on screen — the same condition the
      // address row's own Wrap switch is drawn under.
      {...(prose && editable && (!markdown || source) ? { wrap: { on: wrap } } : {})}
      onWrap={(on) => writeWrapLines(on)}
      markdown={Boolean(markdown && file && !file.binary)}
      source={source}
      onSource={setSource}
      {...(onInsertReference ? { onInsertReference } : {})}
      {...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {})}
    />
  );
  /** The bytes URL for a binary the panel can RENDER (image, audio, video —
   *  a .pdf normally opens as its own `pdf:` tab; this covers a restored
   *  `file:` tab). Versioned by the read's hash so new bytes mean a new URL. */
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The address row, exactly as a browser page tab has one — one shared
          component now (session/editor-chrome.tsx) so the seam does not move
          when you switch to a notebook or a CSV. What is ours goes in its slot. */}
      <ContextMenu>
        {/**
         * THE ADDRESS ROW'S MENU WRAPS THE SHARED ROW rather than reaching into
         * it: `EditorAddressRow` belongs to session/editor-chrome.tsx and four
         * surfaces wear it, and only this one has a menu to hang.
         *
         * A REAL BOX, NOT `display: contents`. A `contents` element paints
         * nothing and is therefore never an event target — only its children
         * are — so a right-press in the row's own `px-2`, or in a gap between
         * the glyph and the path, would sail past this menu. `project-group.tsx`
         * paid a screenshot to learn that; a `shrink-0` div around the row is an
         * ancestor of every point inside it.
         *
         * AND IT DOES NOT TOUCH THE DRAG. `draggable` is on the row INSIDE this
         * box, so the trigger is never itself the drag handle — board.tsx's rule
         * seen from the other side.
         */}
        <ContextMenuTrigger render={<div className="shrink-0" />}>
        <EditorAddressRow
          path={path}
          detail={
            dirty || file ? (
              <>
                {/* UNSAVED IS A DOT, not a word: it has to be legible at a glance
                    from across the row and it must not move the layout when it
                    appears. */}
                {dirty && (
                  <span
                    aria-label="Unsaved changes"
                    title={problem ? "Not saved — see the message below" : "Saving…"}
                    className={cn("size-1.5 shrink-0 rounded-full", problem ? "bg-destructive" : "bg-primary")}
                  />
                )}
                {file && size(file.bytes)}
              </>
            ) : undefined
          }
        >
          {/* WRAP LIVES UP HERE, not in the formatting row below, because it is a
              property of the VIEW rather than an edit to the text — and because
              the formatting row only exists for markdown source, while wrapping
              applies to any prose file. The gutter hides while this is on: a line
              number names a SOURCE line, and under wrap those no longer sit one
              per row. `onMouseDown` prevention keeps the textarea's selection
              alive through the click. */}
          {prose && editable && (!markdown || source) && (
            <button
              type="button"
              role="switch"
              aria-checked={wrap}
              aria-label="Wrap lines"
              title={wrap ? "Wrap lines: on (line numbers hidden while wrapped)" : "Wrap long lines to the panel width"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => writeWrapLines(!wrap)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs transition-colors",
                wrap ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <WrapTextIcon className="size-3" />
              Wrap
            </button>
          )}
          {/* THE MARKDOWN TOGGLE — rendered or source, one press apart. In the
              header rather than floating over the text so it cannot cover what
              it switches, and icon-only because the header row is 36px of
              everything already. */}
          {markdown && file && !file.binary && (
            <div role="group" aria-label="Markdown view" className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
              <button
                type="button"
                aria-pressed={!source}
                title="Rendered"
                onClick={() => setSource(false)}
                className={cn("rounded p-0.5 transition-colors", source ? "text-muted-foreground hover:text-foreground" : "bg-secondary text-foreground")}
              >
                <EyeIcon className="size-3" />
              </button>
              <button
                type="button"
                aria-pressed={source}
                title="Edit source"
                onClick={() => setSource(true)}
                className={cn("rounded p-0.5 transition-colors", source ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <PencilIcon className="size-3" />
              </button>
            </div>
          )}
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

      {/**
       * THE BODY CARRIES THE SAME MENU as the address row — one file, one
       * answer, one list (`FileMenuItems`).
       *
       * ITS TRIGGER FILLS THE REST OF THE COLUMN, and for the reason the row's
       * does not use `contents` either: the empty space under a short file, and
       * the padding around every state that stands in for the text, belong to
       * this box. A `contents` trigger paints none of it and would have answered
       * only where the text already is.
       *
       * NOT ON THE TEXTAREA, THOUGH — it stops the event itself; see it.
       */}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
        {/* WHY THE SAVE DID NOT HAPPEN, above the text rather than in a toast: the
            text on screen is not what is on disk, and that has to stay visible for
            as long as it is true. Only a conflict offers the re-read, because it is
            the only one re-reading fixes. */}
        {problem && (
          <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-2xs leading-snug">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1">
              {REFUSAL[problem.reason] ?? problem.reason}
              {problem.reason === "conflict" && (
                <>
                  {" "}
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="ml-1 align-baseline"
                    onClick={() => {
                      // Discards the draft on purpose — the stash with it, or the
                      // next open would bring the refused text back. Merging two
                      // versions of a file is a diff tool's job, and pretending to
                      // do it here would be the one thing worse than losing the
                      // edit: silently producing a third version nobody wrote.
                      void load(true);
                    }}
                  >
                    Re-read from disk
                  </Button>
                </>
              )}
            </span>
          </div>
        )}

        {error ? (
          <PanelEmpty icon={<FileIcon />} title="Could not read this file">
            {error}
          </PanelEmpty>
        ) : !file || draft === undefined ? (
          file?.binary ? (
            kind.media && mediaUrl ? (
              /**
               * BYTES THE PANEL CAN RENDER. The text route sent nothing (binary),
               * so the media element reads the raw route itself — the browser
               * streams it, and the viewer is the browser's own. Which element is
               * the kind table's `media` verdict; the pdf arm here only serves a
               * restored `file:` tab, since a .pdf normally opens as `pdf:`.
               */
              kind.media === "image" ? (
                <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- raw workspace bytes; next/image cannot optimise a token-gated local route */}
                  <img src={mediaUrl} alt={path} className="max-w-full rounded-md border border-border" />
                </div>
              ) : kind.media === "audio" ? (
                <div className="px-3 py-4">
                  <audio controls src={mediaUrl} className="w-full" />
                </div>
              ) : kind.media === "video" ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
                  <video controls src={mediaUrl} className="max-h-full max-w-full rounded-md" />
                </div>
              ) : (
                <iframe src={mediaUrl} title={path} className="min-h-0 w-full flex-1 border-0" />
              )
            ) : (
              /* NAMED, NOT JUST "BINARY". The table knows this is a font or a
                 lockfile, and "font · 190 KB" is a different sentence from
                 "bytes" — it tells you the read worked and the file is what you
                 expected. Only kinds with no media viewer land here now. */
              <PanelEmpty icon={<FileKindIcon path={path} className="size-5" />} title={`${kind.label} · ${size(file.bytes)}`}>
                Bytes rather than text, so nothing was sent — rendering it as UTF-8 would show line noise instead of the file.
              </PanelEmpty>
            )
          ) : (
            <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
              <Spinner className="size-3" /> reading the file…
            </p>
          )
        ) : markdown && !source ? (
          /**
           * THE RENDERED DOCUMENT — Streamdown via MessageResponse, so a README
           * in the panel is coloured by the same engine as markdown in the
           * transcript (the seam this cockpit keeps closing). It renders the
           * DRAFT, not the file: mid-edit, the preview is one toggle away and
           * must show what would be saved, not what was loaded.
           */
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <MessageResponse className="text-xs-plus">{draft}</MessageResponse>
          </div>
        ) : (
          <>
            {/* THE FORMATTING ROW, only where its edits can land: markdown, in
                source view, editable. Every button routes through the same
                draft + saver pair a keystroke uses. `onMouseDown` prevention
                keeps the textarea's selection alive through the click — a
                focused button has no selection to format.
                `source` is markdown's Rendered/Edit switch. The row is MARKDOWN's
                alone: a .txt has no formatting to apply, and the one control it
                used to borrow this row for (Wrap) is a property of the view and
                moved up to the address row. */}
            {markdown && editable && source && (
              <div role="toolbar" aria-label="Editing" className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
                {MARKDOWN_ACTIONS.map(({ action, label, icon: Icon }) => (
                  <button
                    key={action}
                    type="button"
                    title={label}
                    aria-label={label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyEdit(action)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <Icon className="size-3" />
                  </button>
                ))}
              </div>
            )}
          <div ref={scrollerRef} onScroll={rememberView} className="min-h-0 flex-1 overflow-auto">
            <div className={cn("flex", wrapping ? "min-w-0" : "min-w-max")}>
              {/**
               * THE GUTTER IS STICKY, not fixed and not outside the scroller.
               * Outside, it could not scroll vertically with the code; fixed, it
               * would slide away horizontally. Sticky-left in the same scroll box
               * gives both, and keeps `select-none` doing its job — the numbers are
               * chrome and must never end up in a copied selection.
               *
               * `app-ground` because the gutter IS this surface's canvas — the
               * viewer itself paints no background, so over a backdrop an opaque
               * strip of --background was the one thing in the pane that did not
               * go glassy. The blur comes with it and is not decoration: the
               * gutter's whole job while the code is scrolled sideways is to stop
               * the line it is covering from being read through it.
               */}
              {!wrapping && (
                <div
                  aria-hidden
                  style={CODE_FONT_SIZE}
                  className={cn(
                    "app-ground sticky left-0 z-10 shrink-0 select-none border-r border-border bg-background py-2 pl-3 pr-2 text-right text-muted-foreground/50 tabular-nums backdrop-blur-sm",
                    CODE_GEOMETRY,
                  )}
                >
                  {lines.map((_line, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
              )}

              {/**
               * THE TWO STACKED LAYERS. The `<pre>` paints the colours and is
               * `aria-hidden` — a screen reader should meet the textarea, which is
               * the real control and carries the same text. The textarea is on top
               * with transparent text and a visible caret, so selection and the
               * caret are the browser's own rather than something drawn.
               */}
              <div className="relative min-w-0 flex-1">
                <pre aria-hidden data-shiki style={CODE_FONT_SIZE} className={cn("m-0 px-3 py-2", wrapClass, CODE_GEOMETRY)}>
                  {/* ONE DIV PER LINE OF `lines`, which is the same array the
                      gutter beside it numbers — so the two columns cannot
                      disagree about how many lines there are. */}
                  <CodeLines lines={lines} coloured={coloured} />
                </pre>
                <textarea
                  ref={textareaRef}
                  style={CODE_FONT_SIZE}
                  value={draft}
                  readOnly={!editable}
                  spellCheck={false}
                  aria-label={`${path} — ${editable ? "editable" : "read only"}`}
                  onChange={(event) => {
                    change(event.target.value);
                    // THE FIRST KEYSTROKE IS A DECISION. A file you have typed
                    // into is no longer something you were glancing at, so the
                    // Editor pins it here rather than waiting for a save to land.
                    onEdit?.();
                    rememberView();
                  }}
                  onSelect={rememberView}
                  // THE BROWSER'S OWN EDIT MENU KEEPS THE BOX. Cut, paste, look
                  // up, spelling: a person uses those constantly inside a text
                  // field, and this surface's menu — re-read, reveal, copy the
                  // path — is not worth taking them away for. The body around
                  // the box still carries it.
                  onContextMenu={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    // ⌘S / Ctrl+S saves now. Prevented in both cases so the browser
                    // never offers to save the page instead, even read-only.
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      void saverRef.current?.flush();
                    }
                  }}
                  className={cn(
                    // `text-transparent` with a `caret-` colour is the whole
                    // illusion: the glyphs come from the layer below and the caret
                    // and selection come from here.
                    "absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent px-3 py-2 text-transparent caret-foreground outline-none",
                    wrapClass,
                    CODE_GEOMETRY,
                    // Selection needs to be visible against the coloured text
                    // underneath rather than the transparent text on top.
                    "selection:bg-primary/30 selection:text-transparent",
                    !editable && "cursor-default",
                  )}
                />
              </div>
            </div>

            {/* Said once, at the bottom, and only when it is true. Silence here
                would read as a highlighter that does not work, or an editor that
                refuses for no reason. */}
            {!editable && file.truncated && (
              <p className="border-t border-border px-3 py-2 text-2xs leading-snug text-muted-foreground">
                <Badge variant="outline" className="mr-1.5 px-1 py-0 text-4xs font-normal">
                  read only
                </Badge>
                This is the first part of a {size(file.bytes)} file, so it cannot be saved back — writing a prefix over the whole file would
                drop the rest.
              </p>
            )}
            {kind.lang && draft.length > MAX_HIGHLIGHT_BYTES && (
              <p className="border-t border-border px-3 py-2 text-2xs leading-snug text-muted-foreground">
                Too large to highlight — {kind.label} colouring is skipped above {size(MAX_HIGHLIGHT_BYTES)} because tokenising it would block
                the window for longer than reading it takes.
              </p>
            )}
          </div>
          </>
        )}
        </ContextMenuTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
