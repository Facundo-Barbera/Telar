"use client";

/**
 * THE EDITOR'S TOP BAR, AS ONE RULE.
 *
 * The Editor draws three header rows across its width — the tree's own
 * refresh-and-search line on the left, the open-file strip on the right, and
 * the address row under the strip — and for a while each one sized itself.
 * The strip was pinned at 36px; the tree header was content-sized around a 28px
 * search box and came out at 40px; the address row was four separate blocks,
 * one per file kind, between 33 and 39px. The two `border-b` rules landed a few
 * pixels apart and the seam at the `border-r` showed a step that moved when you
 * opened a different KIND of file (issue #275).
 *
 * So the height and the inset live here, in one string, and everything that
 * draws a header row in the Editor wears it. A row that needs something else —
 * a gap, a cursor — adds it; a row that wants a different HEIGHT is the bug
 * this module exists to prevent, and there is a render test that says so
 * (editor-seam.test.tsx).
 *
 * THE PANEL'S OWN TAB STRIP IS NOT IN THIS FAMILY and stays at `h-10`: it is
 * one level up, it holds surfaces rather than files, and matching it was what
 * made the tree header 40px in the first place.
 */

import type { ReactNode } from "react";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { FileKindIcon } from "@/components/session/file-icon";
import { cn } from "@/lib/utils";

/** 36px, `px-2`, one hairline under it. The Editor's only header height. */
export const EDITOR_HEADER_ROW = "flex h-9 shrink-0 items-center border-b border-border px-2";

/**
 * THE ADDRESS ROW — which file you are looking at, the same in every kind.
 *
 * It was four of these, one per body surface, with three different insets
 * between them; switching from a notebook to a CSV moved the seam. One
 * component now, and what differs per kind goes in the slot rather than into a
 * fourth copy of the row.
 *
 * DRAGGABLE, because the thing you are looking at is usually the thing you want
 * to mention — the same `lib/drag-reference` gesture the tree's rows have.
 *
 * NOTHING SITS OPPOSITE IT ON THE LEFT, and that is chosen rather than missed.
 * The tree has one header; the file side has two rows, because a file needs
 * both "which files are open" and "which one is this" and the tree needs
 * neither. Giving the tree a second, empty bar to square the corner would cost
 * 36px of the narrowest column in the app to say nothing. The seam that has to
 * be continuous is the FIRST one — strip and tree header, both `h-9` — and
 * below it the tree's first row simply begins.
 */
export function EditorAddressRow({
  path,
  icon,
  detail,
  children,
}: {
  path: string;
  /** The glyph. Defaults to the path's own kind; a notebook and a table name
   *  the VIEW instead, because that is the thing that differs about them. */
  icon?: ReactNode;
  /** The one figure this kind reports — a size, a row count. Mono and quiet,
   *  against the path rather than beside the controls. */
  detail?: ReactNode;
  /** Per-kind controls: refresh, wrap, the markdown switch, the kernel pill. */
  children?: ReactNode;
}) {
  const cut = path.lastIndexOf("/");
  return (
    <div
      draggable
      onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(path))}
      title={`${path} — drag into the message to reference this file`}
      className={cn(EDITOR_HEADER_ROW, "cursor-grab gap-2 active:cursor-grabbing")}
    >
      {icon ?? <FileKindIcon path={path} className="size-3.5" />}
      {/* THE PATH IS SPLIT, not truncated from the left: the directories go
          quiet and the name stays legible, which is the one part you scan. */}
      <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">
        {cut > -1 && <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>}
        <span className="text-foreground">{path.slice(cut + 1)}</span>
      </span>
      {detail !== undefined && detail !== false && (
        <span className="flex shrink-0 items-center gap-2 font-mono text-[0.625rem] text-muted-foreground tabular-nums">{detail}</span>
      )}
      {children}
    </div>
  );
}
