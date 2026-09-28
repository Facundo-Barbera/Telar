"use client";

/**
 * THE REVIEW AS A TREE, BESIDE THE ROWS — issue #855.
 *
 * A THIRD VIEW OF THE SAME ROWS, NOT A SECOND LIST. The paths are the ones the
 * surface already folded (`SessionReview.rows`, after the tab's filter), so the
 * tree can never name a file the list does not have; nothing is read from the
 * engine for it.
 *
 * IT OWNS NOTHING ABOUT WHICH PATCH IS OPEN. Clicking a file calls the surface's
 * own toggle — the same `openPaths` the rows and "collapse all" write — so there
 * is one writer and the tree's selection is simply that set, read back. The one
 * state it does own is which DIRECTORIES are folded, which nothing else has an
 * opinion about.
 *
 * FOLDED, NOT EXPANDED, is what is remembered: a review is small enough to show
 * whole, and a directory that appears on the next poll should arrive open rather
 * than hiding the file that just changed.
 */

import { useMemo, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";

import type { GitFileChange } from "@telar/engine-client";
import { buildFileTree, directoryPaths, flattenTree, type FileTreeRow } from "@/lib/file-tree";
import { REVIEW_STATUS_LETTER } from "@/lib/session-review";
import { FileKindIcon } from "@/components/session/file-icon";
import { cn } from "@/lib/utils";

const INDENT = 10;

/** The visible rows: every directory open except the ones folded. Exported for
 *  its tests — ordering and chain collapse are `file-tree.ts`'s, and this is the
 *  one place they meet the review's folded set. */
export function diffTreeRows(paths: readonly string[], folded: ReadonlySet<string>): FileTreeRow[] {
  const tree = buildFileTree(paths);
  return flattenTree(tree, new Set(directoryPaths(tree).filter((path) => !folded.has(path))));
}

export function DiffFileTree({
  files,
  openPaths,
  onSelect,
}: {
  files: readonly GitFileChange[];
  openPaths: ReadonlySet<string>;
  /** The surface's own row toggle. */
  onSelect: (path: string) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const rows = useMemo(() => diffTreeRows([...byPath.keys()], folded), [byPath, folded]);
  const fold = (path: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <nav aria-label="Files in this review" className="border-r border-border py-1">
      <div role="tree">
        {rows.map(({ node, depth }) => {
          const directory = node.kind === "directory";
          const file = directory ? undefined : byPath.get(node.path);
          const expanded = directory && !folded.has(node.path);
          const Folder = expanded ? FolderOpenIcon : FolderIcon;
          return (
            <button
              key={node.path}
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={directory ? false : openPaths.has(node.path)}
              {...(directory ? { "aria-expanded": expanded } : {})}
              onClick={() => (directory ? fold(node.path) : onSelect(node.path))}
              // A RENAME READS AS A MOVE here, as it does on the row: the old
              // path is the one thing the tree's position cannot show.
              title={file?.renamedFrom ? `${file.renamedFrom} → ${node.path}` : node.path}
              style={{ paddingLeft: 6 + depth * INDENT }}
              className={cn(
                "flex h-6 w-full min-w-0 items-center gap-1 pr-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60",
                !directory && openPaths.has(node.path) && "bg-muted/40",
              )}
            >
              <span className="flex size-3 shrink-0 items-center justify-center">
                {directory && <ChevronRightIcon className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
              </span>
              {directory ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FileKindIcon path={node.path} className="size-3.5" />}
              <span className={cn("min-w-0 flex-1 truncate font-mono text-2xs", directory ? "text-foreground" : "text-muted-foreground")}>{node.name}</span>
              {file && <span className="shrink-0 font-mono text-3xs text-muted-foreground">{REVIEW_STATUS_LETTER[file.status]}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
