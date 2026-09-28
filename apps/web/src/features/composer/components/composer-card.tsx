"use client";

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { InputGroup, InputGroupAddon } from "@/ui/input-group";
import { cn } from "@/ui/utils";
import type { ComposerCompletions } from "../hooks/use-composer-completions";
import type { ComposerStash } from "../hooks/use-composer-stash";
import type { useDropTarget } from "../hooks/use-drop-target";
import type { Completion } from "../completions";
import type { ComposerKind } from "../registry";
import { AddContextMenu, AttachmentChip, ComposerChromeMenu } from "./composer-chrome";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";
import { ComposerMenu } from "./composer-menu";
import { ComposerStashMenu } from "./composer-stash-menu";
import { StashBadge } from "./composer-toolbar";

// A right-press on selected text keeps the browser's menu. Both stops are needed: React's keeps the
// card's trigger shut, and the immediate one beats Base UI's document listener.
const keepSelectionMenu = (event: React.MouseEvent<HTMLDivElement>) => {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!selection || selection.isCollapsed || !anchor || !event.currentTarget.contains(anchor)) return;
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation();
};

export function ComposerCard({
  editor,
  editorId,
  kind,
  text,
  placeholder,
  ready,
  compact,
  draft,
  attachments,
  onAttach,
  addFiles,
  onDraftChange,
  onEdit,
  onSelectionChange,
  onKeyDown,
  onFocusChange,
  stash,
  menu,
  pick,
  drop,
  pills,
  trailing,
}: {
  editor: RefObject<ComposerEditorHandle | null>;
  editorId: string;
  kind: ComposerKind;
  text: string;
  placeholder: string;
  ready: boolean;
  compact: boolean;
  draft: string;
  attachments: File[];
  onAttach: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  onDraftChange: (draft: string) => void;
  onEdit: (text: string) => void;
  onSelectionChange: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocusChange: (focused: boolean) => void;
  stash: ComposerStash;
  menu: ComposerCompletions;
  pick: (completion: Completion) => void;
  drop: ReturnType<typeof useDropTarget>;
  pills: ReactNode;
  /** The context ring, dictation and send; while compact, dictation and send. */
  trailing: ReactNode;
}) {
  const chrome = { draft, attachments, stashing: stash.stashing, onClear: () => onDraftChange(""), onStash: () => void stash.stash() };
  const { dropping } = drop;
  return (
    <div className="relative">
      {/* One slot: the stash list only opens over an empty box, and a completion needs text. */}
      {stash.open ? (
        <ComposerStashMenu
          agents={stash.shelf.agents}
          yours={stash.shelf.yours}
          active={Math.min(stash.active, Math.max(0, stash.shelf.rows.length - 1))}
          onActive={stash.setActive}
          onPick={stash.restore}
          onDrop={(row) => stash.shelf.drop(row)}
        />
      ) : menu.open && menu.trigger ? (
        <ComposerMenu
          completions={menu.completions}
          active={Math.min(menu.active, Math.max(0, menu.completions.length - 1))}
          heading={menu.heading()}
          {...(menu.loading ? { loading: true } : {})}
          emptyText="No matches."
          onActive={menu.setActive}
          onPick={pick}
        />
      ) : null}
      <ComposerChromeMenu {...chrome}>
        <InputGroup
          {...drop.handlers}
          className={cn("rounded-2xl border-border/80 bg-card/95 shadow-2 backdrop-blur-xl", dropping && "relative border-ring ring-2 ring-ring/40", compact && "h-auto")}
        >
          {dropping && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-3.5 z-10 flex justify-center">
              <span className="rounded-full border border-ring/50 bg-card px-2.5 py-0.5 text-2xs font-medium text-foreground shadow-1">
                {dropping === "reference" ? "Drop to reference it in your message" : "Drop to add it to your message"}
              </span>
            </div>
          )}
          <label className="sr-only" htmlFor={editorId}>
            Message
          </label>
          <div className="contents" onContextMenu={keepSelectionMenu}>
            <ComposerEditor
              ref={editor}
              id={editorId}
              data-composer={kind}
              value={text}
              placeholder={placeholder}
              disabled={!ready}
              onChange={onEdit}
              onSelectionChange={onSelectionChange}
              onKeyDown={onKeyDown}
              onPasteFiles={addFiles}
              onFocus={() => onFocusChange(true)}
              onBlur={() => onFocusChange(false)}
              compact={compact}
              {...(compact ? { className: "min-w-0 flex-1" } : {})}
            />
          </div>
          {attachments.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-2.5 pt-2.5">
              {attachments.map((file, index) => {
                const remove = () => onAttach(attachments.filter((_, at) => at !== index));
                return (
                  <ComposerChromeMenu key={`${file.name}-${file.size}-${index}`} {...chrome} onRemoveAttachment={remove}>
                    <AttachmentChip file={file} onRemove={remove} />
                  </ComposerChromeMenu>
                );
              })}
            </InputGroupAddon>
          )}
          {compact ? (
            <InputGroupAddon align="inline-end" className="gap-1 self-end py-1.5 pr-1.5">
              <AddContextMenu onPick={addFiles} />
              {trailing}
            </InputGroupAddon>
          ) : (
            <InputGroupAddon align="block-end" className="min-h-10 flex-wrap justify-between gap-1 border-t border-border/40 px-2 pt-1 pb-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <AddContextMenu onPick={addFiles} />
                <StashBadge stash={stash} />
                {pills}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5 self-end">{trailing}</div>
            </InputGroupAddon>
          )}
        </InputGroup>
      </ComposerChromeMenu>
    </div>
  );
}
