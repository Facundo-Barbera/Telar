"use client";

/**
 * THE MIC BUTTON — one component, both composers (#544).
 *
 * ── WHY IT INSERTS THROUGH `window.telar.dictate` ───────────────────────────
 * Not because the page API is convenient from in here — it is in-process, and
 * calling `activeComposer()` directly would work — but because it is the SAME
 * insertion the headset already uses (#548), and dictation arriving by two
 * different paths on one app is two behaviours to keep in step. `dictate` also
 * answers the question this button cannot: WHICH box is being typed into. The
 * session composer and the Agent's are different routes, so in practice one is
 * mounted; the registry is what makes "in practice" unnecessary.
 *
 * ── THE STATE IS LOUD ON PURPOSE ────────────────────────────────────────────
 * This is a toggle, so the failure mode is a recording nobody remembered
 * starting. While it is listening the button is filled rather than tinted, it
 * pulses, and the words being heard are printed under the composer. A quiet
 * recording indicator is the one thing a microphone control must not be.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not send. `dictate({ submit: true })` exists and this does not pass
 * it: a spoken message that goes out before the person has read it back is a
 * message they cannot take back, and the Enter key is right there. "Send it"
 * as a spoken command is a later issue on `window.telar.submit`.
 */

import { MicIcon } from "lucide-react";
import { dictate } from "@/lib/page-api";
import { useDictation } from "@/lib/dictation/use-dictation";
import { cn } from "@/lib/utils";

export function DictationButton({ className }: { className?: string }) {
  const { phase, heard, error, toggle, supported } = useDictation({
    // THE PAGE API, not the composer's own insert: one path, see the header.
    // Its refusal is a sentence, and the only one this button could not have
    // predicted — a composer that unmounted mid-dictation.
    insert: (text) => void dictate(text),
  });

  // NO BUTTON AT ALL where the browser cannot record: an insecure origin, an
  // embed with no microphone permission, a browser without `MediaRecorder`. A
  // control that is always disabled is an advertisement for something the
  // reader cannot have.
  if (!supported) return null;

  const listening = phase === "listening";
  const busy = phase === "starting";

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <button
        type="button"
        aria-label={listening ? "Stop dictating" : "Dictate"}
        aria-pressed={listening}
        title={listening ? "Stop dictating" : "Dictate (speak into the message box)"}
        // THE BOX KEEPS THE CARET. Without this the press blurs the composer,
        // and `dictate` inserts at a caret that is no longer anywhere — the
        // same reason every other control in this row does it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors",
          listening
            ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          busy && "bg-accent text-foreground",
        )}
      >
        <MicIcon className={cn("size-4", listening && "animate-pulse")} />
        {listening && <span className="text-xs">Listening</span>}
      </button>
      {/* WHAT IT IS HEARING, AND IT IS NOT IN THE BOX. Deepgram revises its
          interim guesses — "recur", "record", "recording" — and `dictate`
          cannot retract, so only finalised phrases are inserted. This is where
          the unfinished ones live; see lib/dictation/transcript.ts. */}
      {listening && heard && <span className="min-w-0 truncate text-xs text-muted-foreground italic">{heard}</span>}
      {error && (
        <span role="status" className="min-w-0 truncate text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
