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

// ── the key, and the one way to write it from outside ───────────────────────
//
// THIS MODULE OWNS THE KEY, and now says so in code rather than in a comment
// other files were expected to honour. The workspace's "Start a session
// instead" (CAP-11's equal-weight alternative) seeds a briefing into a
// not-yet-mounted composer, and the first pass had it spell
// `telar:draft:new:${project}` inline in two components — a third and fourth
// definition of a contract this file's own lifecycle rules depend on.
export const newSessionDraftKey = (project: string): string => `telar:draft:new:${project}`;

// The seed is announced as well as stored, because storing alone is only half
// the handoff: a `router.push` into a composer that is ALREADY MOUNTED for this
// project does not remount it, so the restore effect below (which fires on key
// TRANSITIONS only) never runs — and 300 ms later the persist effect overwrites
// the seed with whatever the composer currently holds. The briefing would
// vanish with no feedback. A live composer listens for this event and takes the
// text directly.
export const COMPOSER_DRAFT_SEEDED = "telar:composer-draft-seeded";
export type ComposerDraftSeeded = { key: string; text: string };

// Returns whether the draft was written. `false` means the human declined to
// replace text they already had — an existing draft is THEIR half-typed
// message, and silently destroying it was the first pass's bug. The confirm is
// the same idiom the queue's lane rename/split already use.
export function seedNewSessionDraft(project: string, text: string): boolean {
  const key = newSessionDraftKey(project);
  try {
    const existing = localStorage.getItem(key);
    if (
      existing &&
      existing.trim() &&
      existing !== text &&
      !confirm(
        "This project's new-session composer already has an unsent draft. Replace it with this packet's briefing?",
      )
    ) {
      return false;
    }
    localStorage.setItem(key, text);
  } catch {
    // storage unavailable (private mode): fall through and still announce, so a
    // mounted composer gets the text even though nothing durable was written.
  }
  window.dispatchEvent(
    new CustomEvent<ComposerDraftSeeded>(COMPOSER_DRAFT_SEEDED, { detail: { key, text } }),
  );
  return true;
}

export function ComposerDraft({
  sessionId,
  project,
}: {
  sessionId: string | null;
  project: string;
}) {
  const { value, setInput } = usePromptInputController().textInput;
  const draftKey = sessionId ? `telar:draft:${sessionId}` : newSessionDraftKey(project);

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

  // The seed announcement (see seedNewSessionDraft). Applied straight to the
  // composer, not read back from storage: this is the case where the mount
  // already happened, so there is no key transition to hang a restore on. The
  // human confirmed the replacement at the seeding surface, so it wins over
  // whatever is in the box — that decision belongs there, not here.
  useEffect(() => {
    const onSeeded = (e: Event) => {
      const detail = (e as CustomEvent<ComposerDraftSeeded>).detail;
      if (!detail || detail.key !== draftKey) return;
      setInput(detail.text);
    };
    window.addEventListener(COMPOSER_DRAFT_SEEDED, onSeeded);
    return () => window.removeEventListener(COMPOSER_DRAFT_SEEDED, onSeeded);
  }, [draftKey, setInput]);

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
