"use client";

/**
 * THE MIC BADGE AT THE CARET, WHILE TELAR IS LISTENING (#561).
 *
 * ── WHAT IT IS COPYING, AND WHY ─────────────────────────────────────────────
 * macOS and iOS both put a small floating badge at the insertion point while
 * their own dictation runs, and the owner asked for the same thing here (the
 * reference shot is `docs/design/dictation-caret-reference.png` — iOS's badge
 * sitting over this very composer). It is the right borrowing rather than a
 * cosmetic one: the mic button lives in a toolbar the eye is not on, and the
 * place a person IS looking while they dictate is the place the words are
 * appearing. A recording nobody remembered starting is this feature's whole
 * failure mode, and this is the indicator in the one spot that is already
 * being watched.
 *
 * ── A PORTAL ON `body`, IN VIEWPORT COORDINATES ─────────────────────────────
 * Not a child of the composer, and not inside the editable at any price. Two
 * separate reasons and both are load-bearing:
 *
 *   - INSIDE THE EDITABLE it would be a node `serialize()` walks and `paint()`
 *     destroys — a badge in the middle of somebody's message text, or a
 *     `replaceRange` computing offsets across it. The composer's one rule is
 *     that the draft is a string and the DOM is a drawing of it; this is not
 *     part of that drawing.
 *   - INSIDE THE COMPOSER it would be clipped: the editable is
 *     `overflow-y-auto` and the card around it rounds and clips too, so a badge
 *     anchored on the caret's line would be cut off at the top of the box —
 *     which is exactly where the caret is when somebody starts talking.
 *
 * So it is `position: fixed` against a rect read from `Range.getBoundingClientRect`,
 * which is already viewport-relative, and it renders into `body` where no
 * ancestor's `overflow` or `transform` can reach it.
 *
 * ── IT IS NOT A CONTROL ─────────────────────────────────────────────────────
 * `pointer-events-none` and `aria-hidden`. Tapping it must not do anything —
 * it sits over the words being typed, and a click target there would eat a
 * caret placement in the middle of a sentence. The mic BUTTON is the control,
 * it is still in the toolbar, and it is what a screen reader is told about;
 * this is a second drawing of a state that already has an accessible name.
 */

import { createPortal } from "react-dom";
import { MicIcon } from "lucide-react";
import { languageBadge } from "@/lib/dictation/language-label";
import { cn } from "@/lib/utils";

/** How far above the caret's own line the badge floats, and how far left of
 *  the caret it starts. Both small: it is anchored to the caret, and a badge
 *  that drifted would read as belonging to some other line. */
const LIFT_PX = 6;
const NUDGE_PX = 4;

export function DictationCaretPill({ rect, language, className }: { rect: DOMRect; language: string; className?: string }) {
  /**
   * NOTHING IS PORTALLED ON THE SERVER, and no mounting effect is needed to say
   * so. The usual dance — render nothing, set a flag in an effect, portal on
   * the second pass — exists to avoid a hydration mismatch, and there is none
   * to avoid here: this component is only ever rendered while a microphone is
   * open, which is a state no server render can be in. So the guard is the
   * honest one (is there a `document`?) and the badge appears on the frame the
   * socket opens rather than the one after it.
   */
  if (typeof document === "undefined") return null;

  /**
   * ABOVE THE CARET, NOT BESIDE IT. Beside it is where the next word is about
   * to be written, so a badge there is a badge that covers the thing it is
   * reporting on. Above-left is where both system dictations put it, and it is
   * the only side with room on the first line of an empty box.
   *
   * CLAMPED TO THE VIEWPORT so a caret at the very top or the right edge does
   * not push it off-screen — a dictation started at the top of a scrolled
   * composer is the ordinary case, not the corner one.
   */
  const top = Math.max(rect.top - LIFT_PX - PILL_HEIGHT_PX, MARGIN_PX);
  const left = Math.min(Math.max(rect.left - NUDGE_PX, MARGIN_PX), Math.max(window.innerWidth - PILL_MAX_WIDTH_PX, MARGIN_PX));

  return createPortal(
    <span
      aria-hidden
      data-slot="dictation-caret-pill"
      style={{ top, left }}
      className={cn(
        "pointer-events-none fixed z-50 flex select-none items-center gap-1 rounded-full bg-primary px-2 py-0.5",
        "text-primary-foreground shadow-sm",
        className,
      )}
    >
      <MicIcon className="size-3 animate-pulse" />
      <span className="font-medium text-3xs leading-4 tracking-wide">{languageBadge(language)}</span>
    </span>,
    document.body,
  );
}

/** The badge's own box, for the arithmetic above. Stated rather than measured:
 *  a `getBoundingClientRect` on the pill would be a second layout pass per
 *  interim frame to place a thing whose size never changes. */
const PILL_HEIGHT_PX = 20;
const PILL_MAX_WIDTH_PX = 80;
/** How close to an edge it may sit before it is pushed back. */
const MARGIN_PX = 4;
