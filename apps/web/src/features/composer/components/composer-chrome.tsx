"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { EraserIcon, ImageIcon, LayersIcon, MonitorIcon, PaperclipIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/context-menu";
import { isStashable } from "../hooks/use-composer-stash";

export function AddContextMenu({ onPick }: { onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      {/* Outside the menu: the menu unmounts on select, and an unmounted input never fires change. */}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          onPick([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Add context"
              title="Add context"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => input.current?.click()}>
            <ImageIcon />
            Add photos or files
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <MonitorIcon />
            Take screenshot
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The card's right-click menu. A right-press on selected text in the editor keeps the browser's own. */
export function ComposerChromeMenu({
  draft,
  attachments,
  stashing,
  onClear,
  onStash,
  onRemoveAttachment,
  children,
}: {
  draft: string;
  attachments: readonly File[];
  stashing: boolean;
  onClear: () => void;
  onStash: () => void;
  onRemoveAttachment?: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        {onRemoveAttachment && (
          <>
            <ContextMenuItem onClick={onRemoveAttachment}>
              <XIcon />
              Remove attachment
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!draft} onClick={onClear}>
          <EraserIcon />
          Clear draft
        </ContextMenuItem>
        <ContextMenuItem disabled={stashing || !isStashable(draft, attachments)} onClick={onStash}>
          <LayersIcon />
          Stash draft
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  // Made during render so the first paint has it; the effect only revokes, since an object URL holds the whole file.
  const preview = useMemo(() => (file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <span className="group/chip relative flex items-center gap-2 rounded-lg border border-border bg-background/80 py-1 pl-1 pr-2">
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob URL for a file the user just picked; next/image cannot optimise it
          <img src={preview} alt="" className="size-full object-cover" />
        ) : (
          <PaperclipIcon className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-40 truncate text-2xs font-medium leading-tight">{file.name}</span>
        <span className="text-3xs leading-tight text-muted-foreground">{fileSize(file.size)}</span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/chip:opacity-100 focus-visible:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </span>
  );
}

/** One sheet in the stack tucked behind the composer's top edge; later siblings paint over earlier ones. */
export function ComposerBanner({
  icon,
  title,
  detail,
  action,
  actionLabel,
  onDismiss,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="mx-3 -mb-1">
      <div className="flex items-center gap-2.5 rounded-t-xl border border-b-0 border-border/60 bg-muted/40 px-3 pb-3.5 pt-2 backdrop-blur-sm">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{title}</p>
          <p className="truncate text-2xs text-muted-foreground">{detail}</p>
        </div>
        {action && actionLabel && (
          <button
            type="button"
            onClick={action}
            className="shrink-0 rounded-md border border-border bg-background/80 px-2.5 py-1 text-2xs font-medium transition-colors hover:bg-accent"
          >
            {actionLabel}
          </button>
        )}
        {onDismiss && (
          <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground">
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Why a stash or restore did not happen, said in place; this app has no toasts. */
export function ComposerNote({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-2xs leading-snug text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{note}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
