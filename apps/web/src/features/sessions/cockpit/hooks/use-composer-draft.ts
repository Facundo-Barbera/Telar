"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS, readDraft, writeDraft } from "@/features/composer";
import { appendToDraft } from "../model";

export type DraftOwner = { sessionId: string | undefined; projectId: string | undefined };

/** The composer's unsent text, files and recalled run id, saved per session (or per project canvas) as it changes. */
export function useComposerDraft({ sessionId, projectId }: { sessionId: string | undefined; projectId: string | undefined }) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draftRunId, setDraftRunId] = useState<string>();
  const owner = useRef<DraftOwner>({ sessionId, projectId });
  /** The live text, readable from an effect that must not re-run per keystroke. */
  const draftText = useRef(draft);

  useEffect(() => {
    draftText.current = draft;
  }, [draft]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      if (owner.current.sessionId !== sessionId || owner.current.projectId !== projectId) {
        const leaving = owner.current;
        owner.current = { sessionId, projectId };
        writeDraft(leaving.sessionId, leaving.projectId, draftText.current);
        setDraft(readDraft(sessionId, projectId));
        return;
      }
      // After a reload the stored text only fills an empty box; it never clobbers what is typed.
      const stored = readDraft(sessionId, projectId);
      if (stored) setDraft((current) => current || stored);
    }, 0);
    return () => window.clearTimeout(task);
  }, [sessionId, projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => writeDraft(sessionId, projectId, draft), 400);
    return () => window.clearTimeout(task);
  }, [draft, sessionId, projectId]);

  // Appended rather than spliced: the caret lives inside ComposerEditor, out of reach here.
  const insertIntoComposer = useCallback((text: string) => {
    if (!text) return;
    setDraft((current) => appendToDraft(current, text));
    setDraftRunId(undefined);
  }, []);

  const attachFromPanel = useCallback((files: readonly File[], caption?: string) => {
    if (files.length > 0) setAttachments((current) => [...current, ...files].slice(0, MAX_ATTACHMENTS));
    if (caption) insertIntoComposer(caption);
  }, [insertIntoComposer]);

  const claim = useCallback((next: DraftOwner) => {
    owner.current = next;
  }, []);

  // A recalled draft stops being that turn's retry the moment it is edited.
  const changeDraft = (next: string) => {
    setDraft(next);
    setDraftRunId(undefined);
  };

  return {
    draft, setDraft, changeDraft, attachments, setAttachments, draftRunId, setDraftRunId, claim, draftText, insertIntoComposer, attachFromPanel,
  };
}
