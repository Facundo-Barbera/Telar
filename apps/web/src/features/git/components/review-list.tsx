"use client";

import { useRef } from "react";
import type { GitFileChange, GitFilePatch } from "@telar/engine-client";
import type { SessionReview } from "@/lib/session-review";
import { PanelDivider } from "@/components/ui/panel";
import type { DiffView } from "../hooks/use-diff-view";
import type { PatchWitness } from "../model";
import { DiffFileTree } from "./diff-file-tree";
import type { PullCommentContext } from "./pull-line-comment";
import { ReviewFileRow } from "./review-file-row";

type RowMenu = {
  onOpenFile?: (path: string) => void;
  onOpenInNewPanelTab?: (path: string) => void;
  onInsertReference?: (text: string) => void;
};

/**
 * The file tree beside the rows, unreported rows first. Without `journal` (a canvas, a shared checkout)
 * the transcript speaks for nothing, so no row is badged and there are no dividers.
 */
export function ReviewList({
  shown,
  journal,
  view,
  witness,
  openPaths,
  toggleRow,
  readPatch,
  rowMenu,
  pullComment,
}: {
  shown: SessionReview;
  journal: boolean;
  view: DiffView;
  witness: PatchWitness;
  openPaths: ReadonlySet<string>;
  toggleRow: (path: string) => void;
  readPatch: (file: GitFileChange) => Promise<{ file: GitFilePatch }>;
  rowMenu: RowMenu;
  pullComment: PullCommentContext | undefined;
}) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const selectFromTree = (path: string) => {
    const opening = !openPaths.has(path);
    toggleRow(path);
    if (!opening) return;
    window.requestAnimationFrame(() => rowsRef.current?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" }));
  };
  const rowProps = (file: GitFileChange) => ({
    readPatch,
    file,
    view,
    witness,
    open: openPaths.has(file.path),
    onToggle: () => toggleRow(file.path),
  });

  return (
    <div className="flex min-w-0 items-start">
      {view.tree && shown.rows.length > 1 && (
        <div className="sticky top-0 max-h-[70vh] w-44 shrink-0 overflow-y-auto">
          <DiffFileTree files={shown.rows.map((row) => row.file)} openPaths={openPaths} onSelect={selectFromTree} />
        </div>
      )}
      <div ref={rowsRef} className="flex min-w-0 flex-1 flex-col">
        {journal && shown.rows.filter((row) => !row.reported).length > 0 && shown.rows.some((row) => row.reported) && (
          <PanelDivider label="not in the transcript" />
        )}
        {shown.rows
          .filter((row) => !row.reported)
          .map((row) => (
            <ReviewFileRow
              key={row.file.path}
              {...rowProps(row.file)}
              reported={!journal}
              {...(row.registration ? { registration: row.registration } : {})}
              {...rowMenu}
              {...(pullComment ? { pullComment } : {})}
            />
          ))}
        {journal && shown.rows.some((row) => row.reported) && shown.rows.some((row) => !row.reported) && (
          <PanelDivider label="the session wrote these" />
        )}
        {shown.rows
          .filter((row) => row.reported)
          .map((row) => (
            <ReviewFileRow
              key={row.file.path}
              {...rowProps(row.file)}
              reported
              {...(row.edits ? { edits: row.edits } : {})}
              {...rowMenu}
              {...(pullComment ? { pullComment } : {})}
            />
          ))}
      </div>
    </div>
  );
}
