"use client";

/**
 * WHY A DICTATION DID NOT HAPPEN, SAID THE WAY A TRANSIENT THING SHOULD BE
 * (#707).
 *
 * ── WHAT IT REPLACES, AND WHY THAT WAS WRONG ────────────────────────────────
 * The refusal used to be a red sentence sitting in the composer's toolbar, next
 * to the mic button, `truncate`d to whatever width was left. Three things wrong
 * with it, and the owner named the first: it was as LOUD as the message box
 * itself — `text-destructive` is the app's alarm colour and this is a socket
 * that can be retried by pressing a button again. It STAYED, for the life of
 * the composer, so a failure from ten minutes ago was still shouting during a
 * dictation that worked. And being truncated to a toolbar's spare width, the
 * sentence it was shouting was usually unreadable anyway.
 *
 * ── SO IT IS THE UPDATER'S IDIOM, WHICH IS THIS APP'S ONE ───────────────────
 * `ui/update-toast.tsx` already answers exactly this question for the updater:
 * a caption ANCHORED over the control it is about rather than a corner
 * notification, `pointer-events-none` so it cannot eat a click on what is
 * underneath, popover colours rather than alarm colours, and gone by itself
 * after a few seconds. The shape is deliberately the same; what is not shared
 * is the code, because that component reads an `UpdateStatus` and this one is
 * handed a sentence.
 *
 * LEFT-ANCHORED, not right: the mic sits in the composer's LEFT cluster (the
 * "things that go into this message" one), so the caption grows the way there
 * is room to grow.
 *
 * ── IT DOES NOT INVENT A CAUSE ──────────────────────────────────────────────
 * The sentence is whatever `useDictation` said, unchanged. Some of those
 * sentences are honest and unhelpful — a browser's WebSocket error event
 * carries no reason at all — and the fix for that is on the engine, not here:
 * a friendlier guess drawn in this box would be the app making something up.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Long enough to read a sentence and a half, short enough that nobody has to
 *  dismiss it. A second longer than the updater's four, because these sentences
 *  carry an instruction and its are three words of news. */
export const DICTATION_NOTICE_MS = 6_000;

export function DictationNotice({
  error,
  className,
  dismissMs = DICTATION_NOTICE_MS,
}: {
  /** The refusal and which one it is — see `DictationState.error`. */
  error: { text: string; seq: number } | undefined;
  className?: string;
  /** Overridden only by tests, which have no six seconds to spend. */
  dismissMs?: number;
}) {
  /**
   * WHICH REFUSAL HAS BEEN SEEN — not "is it visible", which is the same
   * distinction `UpdateToast` draws and for a sharper reason here: two presses
   * can fail with the SAME SENTENCE, and a boolean set from this effect would
   * be a cascading render besides. `seq` counts refusals, so a repeat of the
   * same words is a key this has not seen and the caption comes back.
   */
  const [dismissed, setDismissed] = useState<number>();
  const seq = error?.seq;

  useEffect(() => {
    if (seq === undefined || seq === dismissed) return;
    const timer = setTimeout(() => setDismissed(seq), dismissMs);
    return () => clearTimeout(timer);
  }, [seq, dismissed, dismissMs]);

  if (!error || seq === dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="dictation-notice"
      className={cn(
        "pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-max max-w-64 rounded-md border border-border",
        "bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-3",
        "animate-in fade-in-0 slide-in-from-bottom-1",
        className,
      )}
    >
      {error.text}
    </div>
  );
}
