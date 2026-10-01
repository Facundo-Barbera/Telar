"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { appendPrompt, mergeAttachments, type ShelfRow, usePromptShelf } from "@/features/prompts";
import { randomUuid } from "@/platform/random-uuid";
import { encodeForStash, filesFromStash } from "../stash-images";
import type { ComposerEditorHandle } from "../components/composer-editor";

/** The contract's `TurnSubmission.attachments` ceiling, shared with the browser camera. */
export const MAX_ATTACHMENTS = 16;

/** What the box keeps after a stash of `captured`: whatever was typed after it while the pictures encoded. */
export function draftAfterStash(now: string, captured: string): string {
  return now.startsWith(captured) ? now.slice(captured.length) : "";
}

export function isStashable(draft: string, attachments: readonly File[]): boolean {
  return Boolean(draft.trim() || attachments.length > 0);
}

/** ⌘S sets the box aside; any composer can pull it back. Your stash and agent drafts arrive as one list of rows. */
export function useComposerStash({
  draft,
  attachments,
  projectId,
  sessionId,
  onDraftChange,
  onAttach,
  editor,
}: {
  draft: string;
  attachments: File[];
  projectId: string | undefined;
  sessionId: string | undefined;
  onDraftChange: (draft: string) => void;
  onAttach: (files: File[]) => void;
  editor: RefObject<ComposerEditorHandle | null>;
}) {
  const shelf = usePromptShelf(projectId, sessionId);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [stashing, setStashing] = useState(false);
  const [note, setNote] = useState<string>();
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  const held = useRef(attachments);
  useEffect(() => {
    held.current = attachments;
  });

  /** Capture, encode, write, and only then clear: a refused write leaves the box untouched. */
  const stash = useCallback(async () => {
    const text = draft.trim();
    if (!isStashable(text, attachments)) return;
    setNote(undefined);
    setStashing(true);
    let encoded: Awaited<ReturnType<typeof encodeForStash>>;
    try {
      encoded = await encodeForStash(attachments);
    } finally {
      setStashing(false);
    }
    if (!text && encoded.images.length === 0) {
      setNote("These files are too large to stash. Nothing was taken from the box.");
      return;
    }
    const ok = shelf.stash({ id: randomUuid(), at: Date.now(), prompt: text, images: encoded.images });
    if (!ok) {
      setNote("There was no room to stash this. Nothing was taken from the box.");
      return;
    }
    onDraftChange(draftAfterStash(latest.current, draft));
    onAttach(encoded.kept);
    setOpen(false);
  }, [draft, attachments, shelf, onDraftChange, onAttach]);

  const restore = useCallback(
    (row: ShelfRow) => {
      const taken = shelf.take(row, Math.max(0, MAX_ATTACHMENTS - attachments.length));
      if (!taken) return;
      setNote(undefined);
      onDraftChange(appendPrompt(draft, taken.prompt));
      if (taken.images.length > 0) {
        const before = attachments.length;
        onAttach(mergeAttachments(attachments, filesFromStash(taken.images), MAX_ATTACHMENTS));
        // A host that takes no attachments looks like any other; check after the commit and put the images back.
        const images = taken.images;
        window.setTimeout(() => {
          if (held.current.length > before) return;
          shelf.put(images, randomUuid(), Date.now());
          setNote("This chat cannot hold attachments — they are back in the stash.");
        }, 0);
      }
      if (taken.left > 0) {
        setNote(`${taken.left === 1 ? "1 attachment is" : `${taken.left} attachments are`} still in the stash — this box is full.`);
      }
      setOpen(false);
      // An image-only entry changes no text, so the repaint that usually restores the caret never runs.
      editor.current?.focus();
    },
    [attachments, shelf, draft, onDraftChange, onAttach, editor],
  );

  const toggle = () => {
    setOpen((was) => !was);
    setActive(0);
  };

  return { shelf, open, setOpen, active, setActive, stashing, note, setNote, stash, restore, toggle };
}

export type ComposerStash = ReturnType<typeof useComposerStash>;
