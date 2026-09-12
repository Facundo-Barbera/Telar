"use client";

/**
 * ONE PDF, PAGED — the browser's own viewer in a sandboxed frame.
 *
 * NO pdf.js, ON PURPOSE. Every client this panel renders in (Chrome, Safari,
 * the Electron shell with `plugins: true`) ships a PDF viewer that does
 * paging, zoom, search and text selection better than anything worth bundling;
 * an <iframe> over the raw file route is the whole renderer. The frame is NOT
 * `sandbox`ed — Chromium refuses to run its PDF plugin inside a sandboxed
 * frame, so the attribute would blank every document. The guard is upstream
 * instead: the raw route declares `application/pdf` from the extension and
 * sends `nosniff`, so bytes that are secretly HTML render as a broken PDF,
 * never as same-origin script.
 *
 * IT RE-READS WHEN THE FILE MAY HAVE CHANGED, and that is a contract, not a
 * nicety: compile loops (LaTeX → PDF) overwrite the same output path, so a
 * frame that kept its first bytes would show every build but the current one.
 * The `src` carries a generation counter bumped when a turn settles, when the
 * window regains focus, and on the header's refresh button — changing the URL
 * is what forces the frame past every cache between here and the engine.
 *
 * THE METADATA READ COMES FIRST for the reason the binary empty-state exists:
 * an <iframe> whose URL 404s renders the engine's JSON error as a document.
 * The text route already answers "is this file there, and how big" without
 * sending bytes (binary files return empty text), so the frame only mounts
 * once the file is known to exist.
 */
import { useCallback, useEffect, useState } from "react";
import { FileIcon, RotateCwIcon } from "lucide-react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { rawFileUrl } from "@/lib/file-urls";
import { EditorAddressRow } from "@/components/session/editor-chrome";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();

function size(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function PdfSurface({
  path,
  sessionId,
  projectId,
  /** A turn settling is the moment the file on disk may have changed —
   *  the compile loop's own clock. */
  active,
}: {
  path: string;
  sessionId?: string;
  projectId?: string;
  active?: TurnState;
}) {
  const [file, setFile] = useState<WorkspaceFile>();
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    try {
      const read = sessionId ? await api.sessionFile(sessionId, path) : await api.projectFile(projectId!, path);
      setFile((known) => {
        // A new hash means new bytes behind the same name: advance the frame.
        if (known && known.sha256 !== read.file.sha256) setGeneration((v) => v + 1);
        return read.file;
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId, path]);

  useEffect(() => {
    // Deferred, like every read in this panel: a synchronous fetch-and-setState
    // on mount is a cascading render. Re-runs when a turn settles.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  /** Coming back to the window is the other moment disk may have moved —
   *  a compile the user ran in a terminal, a file dropped in from Finder. */
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const src = rawFileUrl(path, { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), version: generation });

  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<FileIcon />} title="No project">
        This file belongs to a checkout, and there is not one to name yet.
      </PanelEmpty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The same address row every file tab wears — literally the same
          component (session/editor-chrome.tsx), so a PDF and a code file put
          their seam in the same place. */}
      <EditorAddressRow path={path} {...(file ? { detail: size(file.bytes) } : {})}>
        <button
          type="button"
          aria-label="Re-read this file"
          title="Re-read from disk"
          onClick={() => {
            setRefreshing(true);
            setGeneration((v) => v + 1);
            void load().finally(() => setRefreshing(false));
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </EditorAddressRow>

      {error ? (
        <PanelEmpty icon={<FileIcon />} title="Could not read this file">
          {error}
        </PanelEmpty>
      ) : !file || !src ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground">
          <Spinner className="size-3" /> reading the file…
        </p>
      ) : (
        /**
         * KEYED BY GENERATION so a refresh replaces the frame rather than
         * navigating it — a navigated iframe keeps its scroll position from a
         * document that no longer exists, which reads as a rendering glitch.
         */
        <iframe key={generation} src={src} title={path} className="min-h-0 w-full flex-1 border-0 bg-background" />
      )}
    </div>
  );
}
