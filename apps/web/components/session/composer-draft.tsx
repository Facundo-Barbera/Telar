"use client";

import { useEffect, useRef } from "react";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";

// THE COMPOSER FORGETS NOTHING (creative-run quick win). Half-typed text
// survives reload and navigation the same way queued messages survive a
// closed dock head: localStorage, keyed per session, restored after mount —
// never during render, where the server has no localStorage and hydration
// would tear (the telar:dock-queued restore established the pattern).
//
// KEY LIFECYCLE IS THE SUBTLETY. A brand-new session composes under
// `telar:draft:new:<project>`; the moment its first send lands a sessionId,
// the key flips to `telar:draft:<sessionId>` IN THE SAME MOUNT — and the old
// key must die right there, or the next new session in this project would
// resurrect a message that was already sent. That same-mount flip is the ONLY
// way the key changes (navigating to another session remounts), so "remove
// the previous key on change" is exactly "clear the sent draft", no more.
//
// An empty value REMOVES the key rather than storing "": send()'s clear, or
// the user deleting their text, both mean there is no draft to keep.
const SAVE_DEBOUNCE_MS = 300;

export function ComposerDraft({
  sessionId,
  project,
}: {
  sessionId: string | null;
  project: string;
}) {
  const { value, setInput } = usePromptInputController().textInput;
  const draftKey = sessionId ? `telar:draft:${sessionId}` : `telar:draft:new:${project}`;

  const restoredForKey = useRef<string | null>(null);
  useEffect(() => {
    const prev = restoredForKey.current;
    if (prev === draftKey) return;
    restoredForKey.current = draftKey;
    try {
      if (prev !== null) localStorage.removeItem(prev);
      const draft = localStorage.getItem(draftKey);
      // Never clobber text the user already typed (a fast typist beats the
      // effect) — restore only into an empty composer.
      if (draft && value === "") setInput(draft);
    } catch {
      // storage unavailable (private mode) — the composer just doesn't persist
    }
    // `value`/`setInput` deliberately absent: this effect is about KEY
    // transitions; the persist effect below owns value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (value) localStorage.setItem(draftKey, value);
        else localStorage.removeItem(draftKey);
      } catch {
        // best-effort, same as above
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, draftKey]);

  return null;
}
