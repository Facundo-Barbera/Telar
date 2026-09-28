"use client";

import type { ComponentProps, RefObject } from "react";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  QuoteIcon,
  StrikethroughIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { WorkspaceFile } from "@telar/engine-client";
import { CODE_FONT_SIZE, CODE_GEOMETRY, CodeLines } from "./overlay-editor";
import { FileKindIcon } from "./file-icon";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { PanelEmpty } from "@/ui/panel";
import type { fileKind } from "../file-kinds";
import { MAX_HIGHLIGHT_BYTES } from "../highlight";
import type { MarkdownEditAction } from "../markdown-edit";
import { cn } from "@/ui/utils";
import type { SaveProblem } from "../hooks/use-file-editor";
import { formatBytes } from "../model";

const REFUSAL: Record<string, string> = {
  conflict: "This file changed on disk while you were editing — most likely the agent wrote it. Your text has not been saved.",
  not_found: "This file is no longer there. It was moved or deleted while you had it open.",
  binary: "The engine reports this file as binary, so there is no text to save back.",
  too_large: "This file is too large for the panel to save safely — it was only partly read, and writing it back would drop the rest.",
};

const MARKDOWN_ACTIONS: { action: MarkdownEditAction; label: string; icon: typeof BoldIcon }[] = [
  { action: "bold", label: "Bold", icon: BoldIcon },
  { action: "italic", label: "Italic", icon: ItalicIcon },
  { action: "strike", label: "Strikethrough", icon: StrikethroughIcon },
  { action: "code", label: "Inline code", icon: CodeIcon },
  { action: "link", label: "Link", icon: LinkIcon },
  { action: "heading", label: "Heading", icon: Heading2Icon },
  { action: "bullet", label: "Bulleted list", icon: ListIcon },
  { action: "quote", label: "Quote", icon: QuoteIcon },
];

/** Why the text on screen is not on disk; only a conflict is fixed by re-reading. */
export function SaveRefusal({ problem, onReread }: { problem: SaveProblem; onReread: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-2xs leading-snug">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        {REFUSAL[problem.reason] ?? problem.reason}
        {problem.reason === "conflict" && (
          <>
            {" "}
            <Button type="button" size="xs" variant="outline" className="ml-1 align-baseline" onClick={onReread}>
              Re-read from disk
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

export function BinaryFile({
  path,
  file,
  kind,
  mediaUrl,
}: {
  path: string;
  file: WorkspaceFile;
  kind: ReturnType<typeof fileKind>;
  mediaUrl: string | undefined;
}) {
  if (!kind.media || !mediaUrl) {
    return (
      <PanelEmpty icon={<FileKindIcon path={path} className="size-5" />} title={`${kind.label} · ${formatBytes(file.bytes)}`}>
        Bytes rather than text, so nothing was sent — rendering it as UTF-8 would show line noise instead of the file.
      </PanelEmpty>
    );
  }
  if (kind.media === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- raw workspace bytes; next/image cannot optimise a token-gated local route */}
        <img src={mediaUrl} alt={path} className="max-w-full rounded-md border border-border" />
      </div>
    );
  }
  if (kind.media === "audio") {
    return (
      <div className="px-3 py-4">
        <audio controls src={mediaUrl} className="w-full" />
      </div>
    );
  }
  if (kind.media === "video") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <video controls src={mediaUrl} className="max-h-full max-w-full rounded-md" />
      </div>
    );
  }
  return <iframe src={mediaUrl} title={path} className="min-h-0 w-full flex-1 border-0" />;
}

export function MarkdownToolbar({ onEdit }: { onEdit: (action: MarkdownEditAction) => void }) {
  return (
    <div role="toolbar" aria-label="Editing" className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
      {MARKDOWN_ACTIONS.map(({ action, label, icon: Icon }) => (
        <button
          key={action}
          type="button"
          title={label}
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onEdit(action)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Icon className="size-3" />
        </button>
      ))}
    </div>
  );
}

/** A transparent textarea over the highlighted lines; both share `CODE_GEOMETRY` or the caret drifts. */
export function CodeEditor({
  path,
  file,
  draft,
  lines,
  coloured,
  editable,
  wrapping,
  wrapClass,
  lang,
  kindLabel,
  textareaRef,
  scrollerRef,
  onChange,
  onView,
  onSave,
}: {
  path: string;
  file: WorkspaceFile;
  draft: string;
  lines: string[];
  coloured: ComponentProps<typeof CodeLines>["coloured"];
  editable: boolean;
  wrapping: boolean;
  wrapClass: string;
  lang: string | undefined;
  kindLabel: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onChange: (text: string) => void;
  onView: () => void;
  onSave: () => void;
}) {
  return (
    <div ref={scrollerRef} onScroll={onView} className="min-h-0 flex-1 overflow-auto">
      <div className={cn("flex", wrapping ? "min-w-0" : "min-w-max")}>
        {!wrapping && (
          <div
            aria-hidden
            style={CODE_FONT_SIZE}
            className={cn(
              "app-ground sticky left-0 z-10 shrink-0 select-none border-r border-border bg-background py-2 pl-3 pr-2 text-right text-muted-foreground/50 tabular-nums backdrop-blur-sm",
              CODE_GEOMETRY,
            )}
          >
            {lines.map((_line, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          <pre aria-hidden data-shiki style={CODE_FONT_SIZE} className={cn("m-0 px-3 py-2", wrapClass, CODE_GEOMETRY)}>
            <CodeLines lines={lines} coloured={coloured} />
          </pre>
          <textarea
            ref={textareaRef}
            style={CODE_FONT_SIZE}
            value={draft}
            readOnly={!editable}
            spellCheck={false}
            aria-label={`${path} — ${editable ? "editable" : "read only"}`}
            onChange={(event) => onChange(event.target.value)}
            onSelect={onView}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                onSave();
              }
            }}
            className={cn(
              "absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent px-3 py-2 text-transparent caret-foreground outline-none",
              wrapClass,
              CODE_GEOMETRY,
              "selection:bg-primary/30 selection:text-transparent",
              !editable && "cursor-default",
            )}
          />
        </div>
      </div>
      {!editable && file.truncated && (
        <p className="border-t border-border px-3 py-2 text-2xs leading-snug text-muted-foreground">
          <Badge variant="outline" className="mr-1.5 px-1 py-0 text-4xs font-normal">
            read only
          </Badge>
          This is the first part of a {formatBytes(file.bytes)} file, so it cannot be saved back — writing a prefix over the whole file would drop
          the rest.
        </p>
      )}
      {lang && draft.length > MAX_HIGHLIGHT_BYTES && (
        <p className="border-t border-border px-3 py-2 text-2xs leading-snug text-muted-foreground">
          Too large to highlight — {kindLabel} colouring is skipped above {formatBytes(MAX_HIGHLIGHT_BYTES)} because tokenising it would block the
          window for longer than reading it takes.
        </p>
      )}
    </div>
  );
}
