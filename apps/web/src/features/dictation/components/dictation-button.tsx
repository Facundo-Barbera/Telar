"use client";

import { MicIcon, SquareIcon } from "lucide-react";
import type { ComposerDictation } from "../hooks/use-composer-dictation";
import { keyCapText, useKeyCapPlatform, useKeymap } from "@/features/commands";
import { DictationCaretPill } from "./dictation-caret-pill";
import { DictationNotice } from "./dictation-notice";
import { cn } from "@/ui/utils";

export function DictationButton({ dictation, className }: { dictation: ComposerDictation; className?: string }) {
  const { phase, error, toggle, available, unavailable, caret } = dictation;
  const keymap = useKeymap();
  const platform = useKeyCapPlatform();
  const chord = keyCapText(keymap["toggle-dictation"] ?? "", platform);
  const chordSuffix = chord === "" ? "" : ` (${chord})`;

  // Configured but refused by this page (e.g. opened over a tailnet IP): drawn dimmed, and the press says why.
  if (!available && unavailable === undefined) return null;

  const listening = phase === "listening";
  const busy = phase === "starting";

  return (
    <div className={cn("relative flex min-w-0 items-center gap-1.5", className)}>
      <button
        type="button"
        aria-label={unavailable ? "Dictation unavailable here" : listening ? "Stop dictating" : "Dictate"}
        aria-pressed={listening}
        // aria-disabled, not disabled: the press must still fire so the notice can say why.
        {...(unavailable ? { "aria-disabled": true } : {})}
        title={unavailable ?? (listening ? `Stop dictating${chordSuffix}` : `Dictate${chordSuffix} — speak into the message box`)}
        // Keeps the composer's caret, so the first words land where the person was typing.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
          listening ? "bg-foreground text-background hover:bg-foreground/85" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          busy && "bg-accent text-foreground",
          unavailable && "opacity-50",
        )}
      >
        {listening ? <SquareIcon data-icon="stop" className="size-3.5 fill-current" /> : <MicIcon data-icon="mic" className="size-4" />}
      </button>
      {listening && caret && <DictationCaretPill rect={caret.rect} language={caret.language} />}
      <DictationNotice error={error} />
    </div>
  );
}
