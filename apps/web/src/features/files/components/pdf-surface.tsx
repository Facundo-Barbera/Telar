"use client";

import { useCallback, useEffect, useState } from "react";
import { FileIcon, RotateCwIcon } from "lucide-react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine/index";
import { rawFileUrl } from "../file-urls";
import { EditorAddressRow } from "./editor-chrome";
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
        if (known && known.sha256 !== read.file.sha256) setGeneration((v) => v + 1);
        return read.file;
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId, path]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

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
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </EditorAddressRow>

      {error ? (
        <PanelEmpty icon={<FileIcon />} title="Could not read this file">
          {error}
        </PanelEmpty>
      ) : !file || !src ? (
        <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
          <Spinner className="size-3" /> reading the file…
        </p>
      ) : (
        <iframe key={generation} src={src} title={path} className="min-h-0 w-full flex-1 border-0 bg-background" />
      )}
    </div>
  );
}
