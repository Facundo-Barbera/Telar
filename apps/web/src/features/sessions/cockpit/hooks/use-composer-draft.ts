"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadDraftFiles, MAX_ATTACHMENTS, readDraft, readDraftFiles, writeDraft, writeDraftFiles } from "@/features/composer";
import { appendToDraft } from "../model";

/** The composer's unsent text, files and recalled run id, saved per session (or per project canvas) as it changes. */
export function useComposerDraft({ sessionId, projectId }: { sessionId: string | undefined; projectId: string | undefined }) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draftRunId, setDraftRunId] = useState<string>();
  const owner = useRef({ sessionId, projectId });
  /** The live text, readable from an effect that must not re-run per keystroke. */
  const draftText = useRef(draft);
  const draftFiles = useRef(attachments);

  useEffect(() => {
    draftText.current = draft;
  }, [draft]);

  useEffect(() => {
    draftFiles.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      if (owner.current.sessionId !== sessionId || owner.current.projectId !== projectId) {
        const leaving = owner.current;
        owner.current = { sessionId, projectId };
        writeDraft(leaving.sessionId, leaving.projectId, draftText.current);
        writeDraftFiles(leaving.sessionId, leaving.projectId, draftFiles.current);
        setDraft(readDraft(sessionId, projectId));
        setAttachments(readDraftFiles(sessionId, projectId));
        return;
      }
      // After a reload the stored draft only fills an empty box; it never clobbers what is typed.
      const stored = readDraft(sessionId, projectId);
      if (stored) setDraft((current) => current || stored);
      void loadDraftFiles(sessionId, projectId).then((files) => {
        if (files.length > 0 && owner.current.sessionId === sessionId && owner.current.projectId === projectId) {
          setAttachments((current) => (current.length > 0 ? current : files));
        }
      });
    }, 0);
    return () => window.clearTimeout(task);
  }, [sessionId, projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => writeDraftFiles(sessionId, projectId, attachments), 400);
    return () => window.clearTimeout(task);
  }, [attachments, sessionId, projectId]);

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

  const claim = useCallback((next: typeof owner.current) => {
    owner.current = next;
  }, []);

  // A recalled draft stops being that turn's retry the moment it is edited.
  const changeDraft = (next: string) => {
    setDraft(next);
    setDraftRunId(undefined);
  };

  return {
    draft, setDraft, changeDraft, attachments, setAttachments, draftRunId, setDraftRunId, claim, draftText, draftFiles, insertIntoComposer, attachFromPanel,
  };
}
