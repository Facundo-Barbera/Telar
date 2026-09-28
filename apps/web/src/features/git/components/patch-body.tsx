"use client";

import { useCallback, useMemo, useState } from "react";
import type { DiffView } from "../hooks/use-diff-view";
import { noHunkSentence, type LineRange } from "../model";
import { DiffCodeView, readPatchShape, toLineRange } from "./diff-code-view";
import { LineRangeAction } from "./line-range-action";
import { PullLineComment, type PullCommentContext } from "./pull-line-comment";

/**
 * The patch, drawn by the diff viewer, with a warning band when the parse complained.
 * The viewer stays mounted under the band, since its recovery is usually most of the patch.
 */
export function PatchBody({
  patch,
  view,
  path,
  onInsertReference,
  pullComment,
}: {
  patch: string;
  view: DiffView;
  path: string;
  onInsertReference?: (text: string) => void;
  pullComment?: PullCommentContext;
}) {
  const reading = useMemo(() => readPatchShape(patch), [patch]);
  const [selection, setSelection] = useState<LineRange>();
  const onLinesSelected = useCallback((range: Parameters<typeof toLineRange>[0] | null) => setSelection(range ? toLineRange(range) : undefined), []);
  const noHunks = !reading.complaint && reading.files === 1 && reading.file?.hunks === 0 ? reading.file : undefined;
  return (
    <>
      {reading.complaint && (
        <p className="px-4 pb-2 text-2xs text-warning">
          This patch did not parse cleanly, so what is drawn below may be wrong or incomplete.{" "}
          <span className="font-mono text-3xs">{reading.complaint}</span>
        </p>
      )}
      {reading.files > 1 && <p className="px-4 pb-2 text-2xs text-warning">This patch describes {reading.files} files, and this row is one file.</p>}
      {noHunks ? (
        <p className="px-4 pb-2 text-2xs text-muted-foreground">{noHunkSentence(noHunks)}</p>
      ) : (
        <div className="mx-3 mb-2 overflow-hidden rounded-md bg-card">
          <DiffCodeView patch={patch} layout={view.layout} wrap={view.wrap} {...(onInsertReference || pullComment ? { onLinesSelected } : {})} />
        </div>
      )}
      {selection && onInsertReference && (
        <LineRangeAction
          path={path}
          range={selection}
          onInsert={(text) => {
            onInsertReference(text);
            setSelection(undefined);
          }}
        />
      )}
      {selection && pullComment && (
        <PullLineComment
          key={`${selection.startSide}:${selection.start}-${selection.endSide}:${selection.end}`}
          context={pullComment}
          path={path}
          patch={patch}
          range={selection}
        />
      )}
    </>
  );
}
