"use client";

import type { ReactNode } from "react";
import { fileReference, startReferenceDrag } from "@/lib/drag-reference";
import { FileKindIcon } from "./file-icon";
import { cn } from "@/lib/utils";

export const EDITOR_HEADER_ROW = "flex h-9 shrink-0 items-center border-b border-border px-2";

export function EditorAddressRow({
  path,
  icon,
  detail,
  children,
}: {
  path: string;
  icon?: ReactNode;
  detail?: ReactNode;
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
      <span className="min-w-0 flex-1 truncate font-mono text-2xs">
        {cut > -1 && <span className="text-muted-foreground">{path.slice(0, cut + 1)}</span>}
        <span className="text-foreground">{path.slice(cut + 1)}</span>
      </span>
      {detail !== undefined && detail !== false && (
        <span className="flex shrink-0 items-center gap-2 font-mono text-3xs text-muted-foreground tabular-nums">{detail}</span>
      )}
      {children}
    </div>
  );
}
