"use client";

/**
 * ONE FILE, OPEN IN THE PANEL.
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
 * SYNTAX HIGHLIGHTED, THE WAY THE TRANSCRIPT ALREADY IS. This file used to argue
 * that colour "would need a highlighter and a language guess per extension" — and
 * both were already here: Streamdown highlights the conversation's fenced code
 * with Shiki, and globals.css already carries the CSS that makes its two-theme
 * output work. So the viewer uses the same library and the same themes
 * (lib/highlight.ts), and a snippet quoted in the conversation now looks like the
 * file it came from.
 *
 * WHAT IT DELIBERATELY IS NOT: an editor. There is no write path in the contract
 * for a client to edit a file with, and drawing a cursor in a read-only view would
 * be a promise the engine cannot keep.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileIcon, RotateCwIcon } from "lucide-react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fileKind } from "@/lib/file-kinds";
import { highlight, MAX_HIGHLIGHT_BYTES, type HighlightedLine } from "@/lib/highlight";
import { FileKindIcon } from "@/components/session/file-icon";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/** Bytes, the way a person reads them. Not for accounting — for deciding whether
 *  what you are looking at is the whole thing. */
function size(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

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
   * a refresh that found new bytes, or a tab that now shows a different file.
   * Carrying the text the tokens were made from turns "is this stale?" into a
   * comparison at render instead of a cleanup that has to fire in time, and it is
   * why nothing has to be cleared when the file changes.
   */
  const [tokenised, setTokenised] = useState<{ of: string; lines: HighlightedLine[] }>();
  const kind = fileKind(path);

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    try {
      const read = sessionId ? await api.sessionFile(sessionId, path) : await api.projectFile(projectId!, path);
      setFile(read.file);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId, path]);

  useEffect(() => {
    // Deferred, like every other read in this panel: a synchronous
    // fetch-and-setState on mount is a cascading render.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  /**
   * LINE NUMBERS AS A SEPARATE COLUMN, so selecting the text and copying it does
   * not carry them along — which is the entire reason not to render them as part
   * of each line. Split once, memoised: a 500KB file is 15,000 lines and this
   * runs on every render otherwise.
   */
  const lines = useMemo(() => (file && !file.binary ? file.text.split("\n") : []), [file]);

  /**
   * HIGHLIGHT AFTER THE TEXT IS ALREADY ON SCREEN, never before it.
   *
   * The grammar is a lazy chunk and tokenising is real work, so the plain lines
   * paint first and the colours replace them a beat later. The other order — wait
   * for Shiki, then show anything — would trade a readable file now for a
   * prettier one soon, which is the wrong way round for a panel you opened to
   * read something.
   *
   * `text` in the deps rather than `file`: re-reading a file that has not changed
   * must not re-tokenise it, and a refresh that finds new bytes must.
   */
  const text = file?.binary ? undefined : file?.text;
  useEffect(() => {
    if (text === undefined) return;
    let cancelled = false;
    void highlight(text, kind.lang).then((lines) => {
      if (!cancelled && lines) setTokenised({ of: text, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [text, kind.lang]);
  /** Only the tokens for the text currently on screen. Anything else is a result
   *  from a file this tab has already moved past. */
  const coloured = tokenised && tokenised.of === text ? tokenised.lines : undefined;

  const cut = path.lastIndexOf("/");

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

      {error ? (
        <PanelEmpty icon={<FileIcon />} title="Could not read this file">
          {error}
        </PanelEmpty>
      ) : !file ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
          <Spinner className="size-3" /> reading the file…
        </p>
      ) : file.binary ? (
        /* NAMED, NOT JUST "BINARY". The table knows this is a PNG image or a
           font, and "PNG image · 190 KB" is a different sentence from "bytes" —
           it tells you the read worked and the file is what you expected. */
        <PanelEmpty icon={<FileKindIcon path={path} className="size-5" />} title={`${kind.label} · ${size(file.bytes)}`}>
          Bytes rather than text, so nothing was sent — rendering it as UTF-8 would show line noise instead of the file.
        </PanelEmpty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* `data-shiki` is what globals.css keys the two-theme token rules on.
              A data attribute rather than a class so it cannot be tree-shaken by
              Tailwind's scanner, which is the same trap the transcript's code
              blocks fell into. */}
          <table data-shiki className="w-full border-collapse font-mono text-[11px] leading-[1.55]">
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="align-baseline">
                  {/* `select-none` and a right-aligned fixed column: the numbers
                      are chrome, and they must not end up in a paste. */}
                  <td className="w-9 select-none pr-2 text-right text-muted-foreground/50 tabular-nums">{index + 1}</td>
                  <td className="whitespace-pre pr-3 text-foreground">
                    {/* THE TOKENS CARRY BOTH THEMES AS CSS VARIABLES and the
                        `[data-shiki]` rules pick one — so switching light/dark
                        repaints the file without re-tokenising it, and without
                        this component knowing which theme is on. Plain text until
                        the grammar lands, and for good on a file too large or a
                        language Shiki does not have. */}
                    {coloured?.[index]
                      ? coloured[index].map((token, at) => (
                          <span key={at} style={token.style as React.CSSProperties}>
                            {token.text}
                          </span>
                        ))
                      : line || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Said once, at the bottom, and only when it is true: a file this big
              is shown as plain text on purpose. Silence here would read as a
              highlighter that does not work. */}
          {!file.binary && kind.lang && file.text.length > MAX_HIGHLIGHT_BYTES && (
            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              Too large to highlight — {kind.label} colouring is skipped above {size(MAX_HIGHLIGHT_BYTES)} because tokenising it would block
              the window for longer than reading it takes.
            </p>
          )}
          {file.truncated && (
            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              <Badge variant="outline" className="mr-1.5 px-1 py-0 text-[9px] font-normal">
                cut
              </Badge>
              This is the first part of a {size(file.bytes)} file. The rest was not sent — a viewer that showed half a file without saying so
              would show a syntax error that is not in the source.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
