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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fileKind } from "@/lib/file-kinds";
import { highlight, MAX_HIGHLIGHT_BYTES, type HighlightedLine } from "@/lib/highlight";
import { SaveCoordinator, type SaveOutcome } from "@/lib/save-coordinator";
import { FileKindIcon } from "@/components/session/file-icon";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

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
 * The shared type geometry of the two stacked layers.
 *
 * IDENTICAL ON BOTH, OR THE CARET DRIFTS. Every property here affects where a
 * glyph lands: change one on the textarea and not on the `<pre>` and the invisible
 * text slides out from under the coloured text, a character at a time, further
 * with every line. It is one constant for that reason.
 */
const CODE_GEOMETRY = "font-mono text-[11px] leading-[1.55] tracking-normal";

export function FileViewSurface({
  path,
  sessionId,
  projectId,
  /** A turn settling is the moment the file on disk may have changed. */
  active,
}: {
  path: string;
  sessionId?: string;
  projectId?: string;
  active?: TurnState;
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
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ refused: boolean; reason: string }>();
  const kind = fileKind(path);

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    try {
      const read = sessionId ? await api.sessionFile(sessionId, path) : await api.projectFile(projectId!, path);
      setFile(read.file);
      setDraft(read.file.binary ? undefined : read.file.text);
      setProblem(undefined);
      setPending(false);
      setError(undefined);
      return read.file;
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
      return undefined;
    }
  }, [sessionId, projectId, path]);

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
   * would reset the debounce it exists to hold. Re-made when the file's IDENTITY
   * changes — a different path, or a re-read that produced a new baseline hash —
   * because the hash it sends with every write comes from that read.
   */
  const saverRef = useRef<SaveCoordinator | null>(null);
  const baseline = file && !file.binary ? file.sha256 : undefined;
  useEffect(() => {
    if (!editable || !baseline) return;
    let current = baseline;
    const persist = async (text: string): Promise<SaveOutcome> => {
      try {
        const result = sessionId
          ? await api.writeSessionFile(sessionId, path, text, current)
          : await api.writeProjectFile(projectId!, path, text, current);
        if (result.written) {
          // The next write must carry the hash of what we just wrote, or the
          // second keystroke after a save is refused as a conflict with itself.
          current = result.file.sha256;
          /**
           * AND THE HEADER HAS TO FOLLOW. `file` is what the last READ returned,
           * so without this the size stays at whatever the file was when it was
           * opened — a saved file reading "11 B" beside 41 bytes of text, which I
           * only noticed because it sat next to a conflict banner and made the
           * banner look wrong too.
           */
          setFile((known) => (known ? { ...known, ...result.file } : known));
          return { status: "saved" };
        }
        return { status: "refused", reason: result.refusal };
      } catch (cause) {
        return { status: "failed", reason: cause instanceof VNextApiError ? cause.message : "The save could not be sent." };
      }
    };
    const saver = new SaveCoordinator({
      debounceMs: SAVE_DEBOUNCE_MS,
      persist,
      onPending: setPending,
      onSaved: () => setProblem(undefined),
      onProblem: (outcome) => setProblem({ refused: outcome.status === "refused", reason: outcome.reason }),
    });
    saverRef.current = saver;
    return () => {
      // FLUSHES, not cancels — see `dispose`. Closing the tab a moment after
      // typing must not throw the last keystrokes away.
      saver.dispose();
      saverRef.current = null;
    };
  }, [editable, baseline, sessionId, projectId, path]);

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
  /** Only the tokens for the text currently on screen. Anything else is a result
   *  from text this tab has already moved past. */
  const coloured = tokenised && tokenised.of === draft ? tokenised.lines : undefined;

  const cut = path.lastIndexOf("/");
  const dirty = pending || Boolean(problem);

  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<FileIcon />} title="No project">
        This file belongs to a checkout, and there is not one to name yet.
      </PanelEmpty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The address row, exactly as a browser page tab has one — and draggable
          for the same reason: the thing you are looking at is usually the thing
          you want to mention. */}
      <div
        draggable
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(path))}
        title={`${path} — drag into the message to reference this file`}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
      >
        <FileKindIcon path={path} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {cut > -1 && <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>}
          <span className="text-foreground">{path.slice(cut + 1)}</span>
        </span>
        {/* UNSAVED IS A DOT, not a word: it has to be legible at a glance from
            across the row and it must not move the layout when it appears. */}
        {dirty && (
          <span
            aria-label="Unsaved changes"
            title={problem ? "Not saved — see the message below" : "Saving…"}
            className={cn("size-1.5 shrink-0 rounded-full", problem ? "bg-destructive" : "bg-primary")}
          />
        )}
        {file && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{size(file.bytes)}</span>}
        <button
          type="button"
          aria-label="Re-read this file"
          title="Re-read from disk"
          onClick={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </div>

      {/* WHY THE SAVE DID NOT HAPPEN, above the text rather than in a toast: the
          text on screen is not what is on disk, and that has to stay visible for
          as long as it is true. Only a conflict offers the re-read, because it is
          the only one re-reading fixes. */}
      {problem && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-[11px] leading-snug">
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
                    // Discards the draft on purpose. Merging two versions of a
                    // file is a diff tool's job, and pretending to do it here
                    // would be the one thing worse than losing the edit: silently
                    // producing a third version nobody wrote.
                    void load();
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
          /* NAMED, NOT JUST "BINARY". The table knows this is a PNG image or a
             font, and "PNG image · 190 KB" is a different sentence from "bytes" —
             it tells you the read worked and the file is what you expected. */
          <PanelEmpty icon={<FileKindIcon path={path} className="size-5" />} title={`${kind.label} · ${size(file.bytes)}`}>
            Bytes rather than text, so nothing was sent — rendering it as UTF-8 would show line noise instead of the file.
          </PanelEmpty>
        ) : (
          <p className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> reading the file…
          </p>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-w-max">
            {/**
             * THE GUTTER IS STICKY, not fixed and not outside the scroller.
             * Outside, it could not scroll vertically with the code; fixed, it
             * would slide away horizontally. Sticky-left in the same scroll box
             * gives both, and keeps `select-none` doing its job — the numbers are
             * chrome and must never end up in a copied selection.
             */}
            <div
              aria-hidden
              className={cn(
                "sticky left-0 z-10 shrink-0 select-none border-r border-border bg-background py-2 pl-3 pr-2 text-right text-muted-foreground/50 tabular-nums",
                CODE_GEOMETRY,
              )}
            >
              {lines.map((_line, index) => (
                <div key={index}>{index + 1}</div>
              ))}
            </div>

            {/**
             * THE TWO STACKED LAYERS. The `<pre>` paints the colours and is
             * `aria-hidden` — a screen reader should meet the textarea, which is
             * the real control and carries the same text. The textarea is on top
             * with transparent text and a visible caret, so selection and the
             * caret are the browser's own rather than something drawn.
             */}
            <div className="relative min-w-0 flex-1">
              <pre aria-hidden data-shiki className={cn("m-0 whitespace-pre px-3 py-2", CODE_GEOMETRY)}>
                {lines.map((line, index) => (
                  <div key={index}>
                    {coloured?.[index]
                      ? coloured[index].map((token, at) => (
                          <span key={at} style={token.style as React.CSSProperties}>
                            {token.text}
                          </span>
                        ))
                      : line || " "}
                  </div>
                ))}
              </pre>
              <textarea
                value={draft}
                readOnly={!editable}
                spellCheck={false}
                aria-label={`${path} — ${editable ? "editable" : "read only"}`}
                onChange={(event) => {
                  setDraft(event.target.value);
                  saverRef.current?.change(event.target.value);
                }}
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
                  "absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre border-0 bg-transparent px-3 py-2 text-transparent caret-foreground outline-none",
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
            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              <Badge variant="outline" className="mr-1.5 px-1 py-0 text-[9px] font-normal">
                read only
              </Badge>
              This is the first part of a {size(file.bytes)} file, so it cannot be saved back — writing a prefix over the whole file would
              drop the rest.
            </p>
          )}
          {kind.lang && draft.length > MAX_HIGHLIGHT_BYTES && (
            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              Too large to highlight — {kind.label} colouring is skipped above {size(MAX_HIGHLIGHT_BYTES)} because tokenising it would block
              the window for longer than reading it takes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
