"use client";

import { useEffect, useState } from "react";
import type { GitFileChange, GitFilePatch } from "@telar/engine-client";
import { REVIEW_STATUS_LETTER, REVIEW_STATUS_WORD } from "../session-review";
import { fileReference, startReferenceDrag } from "@/features/composer";
import { Badge } from "@/ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/context-menu";
import { PanelRow } from "@/ui/panel";
import { Spinner } from "@/ui/spinner";
import type { DiffView } from "../hooks/use-diff-view";
import { INCOMPLETE_PATCH, type PatchWitness } from "../model";
import { PatchBody } from "./patch-body";
import type { PullCommentContext } from "./pull-line-comment";

type RowActions = {
  onOpenFile?: (path: string) => void;
  onOpenInNewPanelTab?: (path: string) => void;
  onInsertReference?: (text: string) => void;
};

/** One changed file. Its patch is read when opened, with the whole row so a rename is read with both paths. */
export function ReviewFileRow({
  readPatch,
  file,
  reported,
  edits,
  registration,
  view,
  open,
  witness = "git",
  onToggle,
  onOpenFile,
  onOpenInNewPanelTab,
  onInsertReference,
  pullComment,
}: RowActions & {
  readPatch: (file: GitFileChange) => Promise<{ file: GitFilePatch }>;
  witness?: PatchWitness;
  file: GitFileChange;
  reported: boolean;
  view: DiffView;
  open: boolean;
  onToggle: () => void;
  edits?: number;
  registration?: true;
  pullComment?: PullCommentContext;
}) {
  // Stamped with its reader: a new reader (whitespace flag, base) discards the answer in the same render.
  const [answer, setAnswer] = useState<{ reader: typeof readPatch; patch?: GitFilePatch; failed: boolean }>({ reader: readPatch, failed: false });
  const current = answer.reader === readPatch ? answer : { reader: readPatch, failed: false };
  if (current !== answer) setAnswer(current);
  const { patch, failed } = current;

  useEffect(() => {
    if (!open || patch !== undefined || failed) return;
    let cancelled = false;
    void readPatch(file)
      .then((result) => {
        if (!cancelled) setAnswer({ reader: readPatch, patch: result.file, failed: false });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ reader: readPatch, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // The row object is rebuilt on every poll with the same fields; depending on it would re-read an open patch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patch, failed, readPatch, file.path, file.status, file.renamedFrom]);

  const actions = { ...(onInsertReference ? { onInsertReference } : {}), ...(pullComment ? { pullComment } : {}) };
  return (
    <div data-diff-path={file.path} draggable onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(file.path))}>
      <ContextMenu>
        <ContextMenuTrigger>
          <PanelRow className="p-0 pl-0">
            <RowSummary file={file} reported={reported} edits={edits} registration={registration} open={open} onToggle={onToggle} />
          </PanelRow>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-auto">
          {onOpenFile && <ContextMenuItem onClick={() => onOpenFile(file.path)}>Open in Editor</ContextMenuItem>}
          {onOpenInNewPanelTab && <ContextMenuItem onClick={() => onOpenInNewPanelTab(file.path)}>Open in a new panel tab</ContextMenuItem>}
          {(onOpenFile || onOpenInNewPanelTab) && <ContextMenuSeparator />}
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(file.path)}>Copy path</ContextMenuItem>
          {onInsertReference && <ContextMenuItem onClick={() => onInsertReference(fileReference(file.path).text)}>Insert as reference</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onToggle}>{open ? "Collapse patch" : "Expand patch"}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open &&
        (failed ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">
            {witness === "git" ? "git could not produce a patch for this path." : "This turn's patch for the file could not be read."}
          </p>
        ) : patch === undefined ? (
          <p className="flex items-center gap-2 px-4 pb-2 text-2xs text-muted-foreground">
            <Spinner className="size-3" /> reading the diff…
          </p>
        ) : patch.incomplete ? (
          <>
            <p className="px-4 pb-2 text-2xs text-warning">{INCOMPLETE_PATCH[patch.incomplete][witness]}</p>
            {patch.patch !== "" && <PatchBody patch={patch.patch} view={view} path={file.path} {...actions} />}
          </>
        ) : patch.binary ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">Binary file — no textual diff.</p>
        ) : patch.patch === "" ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">No textual difference.</p>
        ) : (
          <PatchBody patch={patch.patch} view={view} path={file.path} {...actions} />
        ))}
      {file.renamedFrom && <p className="px-4 pb-2 pl-[1.9rem] text-2xs text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

function RowSummary({
  file,
  reported,
  edits,
  registration,
  open,
  onToggle,
}: {
  file: GitFileChange;
  reported: boolean;
  edits: number | undefined;
  registration: true | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const cut = file.path.lastIndexOf("/");
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs hover:bg-muted/60"
      aria-expanded={open}
      onClick={onToggle}
      title={file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
    >
      <span className="w-3 shrink-0 font-mono text-3xs text-muted-foreground" title={REVIEW_STATUS_WORD[file.status]}>
        {REVIEW_STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs">
        {cut > -1 && <span className="text-muted-foreground">{file.path.slice(0, cut + 1)}</span>}
        <span className="text-foreground">{file.path.slice(cut + 1)}</span>
      </span>
      {!reported && !registration && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal text-warning">
          unreported
        </Badge>
      )}
      {registration && (
        <Badge
          variant="outline"
          className="shrink-0 px-1 py-0 text-4xs font-normal"
          title="Telar’s own ignore rules — telar.yaml and .telar/ — added when this project was registered, not by this session"
        >
          setup
        </Badge>
      )}
      {edits !== undefined && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal" title={`The session wrote this ${edits} times`}>
          ×{edits}
        </Badge>
      )}
      {file.binary && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
          bin
        </Badge>
      )}
      <span className="shrink-0 font-mono text-3xs tabular-nums">
        {file.linesAdded ? <span className="text-success">+{file.linesAdded}</span> : null}
        {file.linesAdded && file.linesRemoved ? " " : null}
        {file.linesRemoved ? <span className="text-destructive">−{file.linesRemoved}</span> : null}
      </span>
    </button>
  );
}
