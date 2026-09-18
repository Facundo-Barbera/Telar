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
 * ── AND IT IS NOT THERE UNLESS SOMEBODY ASKED FOR IT ────────────────────────
 * `dictation.provider` defaults to `off` and there is no button until it is
 * something else. macOS dictation and Wispr Flow work on this composer already
 * — it is a plain editable — so a mic button that appeared uninvited would be
 * Telar claiming a job the reader may have given to something else.
 *
 * ── IT NO LONGER OWNS THE DICTATION (#588) ──────────────────────────────────
 * `useDictation` used to be called right here, which was correct while this was
 * the only way to start one. ⌘D is a second caller, and a command handler with
 * its own instance of the hook would be a second microphone over the same
 * composer. The composer holds the one machine now (`useComposerDictation`) and
 * hands it down; this is the control that draws it. Every refusal below is the
 * same value the chord refuses on, because it is the same object.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not send. A spoken message that goes out before the person has read
 * it back is a message they cannot take back, and the Enter key is right there.
 * "Send it" as a spoken command is a later issue on `window.telar.submit`.
 */

import { MicIcon } from "lucide-react";
import type { ComposerDictation } from "@/lib/dictation/use-composer-dictation";
import { DictationCaretPill } from "./dictation-caret-pill";
import { cn } from "@/lib/utils";

export function DictationButton({ dictation, className }: { dictation: ComposerDictation; className?: string }) {
  const { phase, error, toggle, available, caret } = dictation;

  // NO BUTTON WHERE NOBODY ASKED FOR ONE, and none where the browser cannot
  // record. `available` is both facts, answered once for the button and the
  // chord — see `useComposerDictation` for why each of them is a refusal.
  if (!available) return null;

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
      {/* THE BADGE AT THE CARET (#561), drawn from here because this is where
          the dictation's state lives — but portalled onto `body` and positioned
          in viewport coordinates, so it owes nothing to where this button sits
          in the toolbar. Absent whenever there is no caret to sit beside. */}
      {listening && caret && <DictationCaretPill rect={caret.rect} language={caret.language} />}
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
