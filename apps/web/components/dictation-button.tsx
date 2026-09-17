"use client";

/**
 * THE MIC BUTTON — one component, both composers (#544).
 *
 * ── WHY IT WRITES THROUGH THE REGISTRY AND NOT THE PAGE API ─────────────────
 * It used to go through `window.telar.dictate`, so that dictation arrived by
 * one path whether it came from here or from the Quest cockpit (#548). That
 * stopped being possible when the words moved INTO the box: rewriting a guess
 * in place needs an insertion that can be taken back, and `dictate` must never
 * grow one — an external client that could delete a run of the draft could
 * delete what the PERSON typed.
 *
 * So the retraction lives on the composer registry, which the page API is built
 * on top of and which only this app's own components can reach. The registry is
 * still what answers the question this button cannot — WHICH box is being typed
 * into — and `dictate` is unchanged for the clients that have it.
 *
 * ── THE STATE IS LOUD ON PURPOSE ────────────────────────────────────────────
 * This is a toggle, so the failure mode is a recording nobody remembered
 * starting. While it is listening the button is filled rather than tinted and
 * it pulses. The words themselves are now the loudest signal there is: they
 * appear in the composer as they are heard.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not send. A spoken message that goes out before the person has read
 * it back is a message they cannot take back, and the Enter key is right there.
 * "Send it" as a spoken command is a later issue on `window.telar.submit`.
 */

import { useCallback } from "react";
import { MicIcon } from "lucide-react";
import { activeComposer } from "@/lib/composer-registry";
import { useDictation } from "@/lib/dictation/use-dictation";
import type { DictationBox } from "@/lib/dictation/interim";
import { cn } from "@/lib/utils";

export function DictationButton({ className }: { className?: string }) {
  // RESOLVED AT THE PRESS, not at render: "the active composer" is a question
  // whose answer changes with focus, and the hook asks it once per dictation.
  const box = useCallback((): DictationBox | undefined => activeComposer(), []);
  const { phase, error, toggle, supported } = useDictation({ box });

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
        // and the first words land at a caret that is no longer anywhere — the
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
      {/* NO CAPTION OF UNCONFIRMED WORDS ANY MORE — they are in the composer,
          rewritten in place as Deepgram revises them. A refusal still needs
          somewhere to be said, and this is it. */}
      {error && (
        <span role="status" className="min-w-0 truncate text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
