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
import { keyCapText, useKeyCapPlatform } from "@/lib/key-caps";
import { useKeymap } from "@/lib/use-command-keys";
import { DictationCaretPill } from "./dictation-caret-pill";
import { DictationNotice } from "./dictation-notice";
import { cn } from "@/lib/utils";

export function DictationButton({ dictation, className }: { dictation: ComposerDictation; className?: string }) {
  const { phase, error, toggle, available, unavailable, caret } = dictation;
  /**
   * THE CHORD THE TOOLTIP NAMES, READ FROM THE LIVE KEYMAP (#588) — never the
   * literal "⌘D". A person who moved Dictate onto another key in Settings ›
   * Keybindings must see the key they chose, and a person who UNBOUND it must
   * see no chord at all rather than one that does nothing. Same store the
   * dispatcher matches against, so the tooltip and the key cannot disagree.
   *
   * Above the early return, because it is a hook.
   */
  const keymap = useKeymap();
  const platform = useKeyCapPlatform();
  const chord = keyCapText(keymap["toggle-dictation"] ?? "", platform);
  /** Empty for an unbound command — the tooltip is then the sentence it was
   *  before this button had a chord at all, rather than an empty bracket. */
  const chordSuffix = chord === "" ? "" : ` (${chord})`;

  // NO BUTTON WHERE NOBODY ASKED FOR ONE — `dictation.provider` is `off` and
  // there is nothing to say about a feature that was never turned on.
  //
  // BUT A BUTTON THAT EXPLAINS ITSELF WHERE SOMEBODY DID (#639). `unavailable`
  // is the case where the provider is configured and THIS PAGE is what stops
  // the recording — the cockpit opened over a tailnet IP rather than on this
  // Mac. That used to draw nothing too, which is how a working feature came to
  // vanish without a word on every device that is not the Mac. It is drawn
  // unavailable, and the press says why.
  if (!available && unavailable === undefined) return null;

  const listening = phase === "listening";
  const busy = phase === "starting";

  return (
    // RELATIVE, because the notice is anchored over this control rather than
    // laid out beside it — see `DictationNotice`, and `UpdateToast` before it,
    // which needs the same of its parent.
    <div className={cn("relative flex min-w-0 items-center gap-1.5", className)}>
      <button
        type="button"
        aria-label={unavailable ? "Dictation unavailable here" : listening ? "Stop dictating" : "Dictate"}
        aria-pressed={listening}
        // `aria-disabled`, NOT `disabled`. A disabled button does not fire a
        // click, so pressing it would be the silence this change exists to
        // remove — and the press is the only way the sentence gets read. The
        // control announces that it cannot record and remains pressable in
        // order to say why.
        {...(unavailable ? { "aria-disabled": true } : {})}
        // THE NAME STAYS THE NAME, the chord is an aside. `aria-label` is
        // deliberately left alone: a screen reader gets the chord from the
        // application's own keybindings, and a button whose NAME changed when
        // somebody rebound a key would be a button nothing could be told to
        // press by name.
        // THE WHOLE SENTENCE IN THE TOOLTIP where there is one, rather than a
        // summary of it: a pointer resting on the control is the cheapest way
        // to read it, and the notice below says the same words on the press
        // for everyone with no pointer at all.
        title={unavailable ?? (listening ? `Stop dictating${chordSuffix}` : `Dictate${chordSuffix} — speak into the message box`)}
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
          // DIMMED, NOT ALARMED. This is a fact about where the page was
          // opened from, not a failure — the popover colours of the notice
          // make the same choice, and `text-destructive` is reserved for
          // things that went wrong.
          unavailable && "opacity-50",
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
          somewhere to be said, and this is it — ANCHORED OVER THE BUTTON AND
          GONE BY ITSELF (#707), rather than the red sentence in the toolbar it
          used to be. `DictationNotice` has the whole argument. */}
      <DictationNotice error={error} />
    </div>
  );
}
