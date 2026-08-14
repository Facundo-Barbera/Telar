"use client";

/**
 * A SENT MESSAGE, DRAWN THE WAY IT WAS WRITTEN.
 *
 * The composer turns a dropped issue into a chip: a green glyph and `#409`. Then
 * you pressed send, and the transcript rendered `turn.prompt` as one flat
 * string — so the same message came back as
 * `#409 "Datos · Identidad de plataforma: …" (https://github.com/…)`, URL and
 * all. Every gesture this cockpit has for referring to a thing produced a chip
 * that survived exactly until the moment it mattered.
 *
 * THE FIX IS THE MODEL WORKING AS DESIGNED, not new state. `composer-tokens.ts`
 * has always insisted the draft is plain text and a chip is a way of DRAWING a
 * run of it — which means the drawing is reproducible from the text alone, by
 * anything, at any time. `segmentDraft` is that reader; it was simply only ever
 * called by the editor. Nothing is stored, nothing is resolved, and the string
 * the model received is still the string on screen.
 *
 * A REFERENCE THIS CANNOT PARSE RENDERS AS PROSE, which is the honest failure:
 * an issue title containing a double quote falls out of the pattern and the
 * message reads exactly as it did before. A missing decoration, not a missing
 * message.
 */

import { Fragment } from "react";
import { CHIP_CLASS, CHIP_ICON_CLASS, CHIP_LABEL_CLASS, chipTitle } from "@/lib/composer-chip";
import { segmentDraft } from "@/lib/composer-tokens";
import { chipGlyphFor } from "@/lib/glyph-paths";
import { cn } from "@/lib/utils";
import type { TelarReference } from "@/lib/drag-reference";

/**
 * One `<svg>`, built the way lucide builds one — the React twin of
 * `glyphElement`.
 *
 * `dangerouslySetInnerHTML` IS A DATA LOOKUP HERE, not an injection: the markup
 * is `glyph-paths.ts`'s own constants, indexed by a reference KIND that is a
 * closed union. No part of it comes from the message.
 */
function ChipGlyph({ markup, className }: { markup: string; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function ReferenceChip({ reference }: { reference: TelarReference }) {
  const { markup, tint } = chipGlyphFor(reference);
  return (
    <span className={CHIP_CLASS} title={chipTitle(reference)}>
      <ChipGlyph markup={markup} className={cn(CHIP_ICON_CLASS, tint)} />
      <span className={CHIP_LABEL_CLASS}>{reference.label}</span>
    </span>
  );
}

/**
 * `whitespace-pre-wrap` STAYS ON THE PARAGRAPH. The prompt is what a person
 * typed, newlines included, and a chip is inline inside it — so the wrapping
 * rule belongs to the block, not to each run.
 */
export function PromptText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("whitespace-pre-wrap", className)}>
      {segmentDraft(text).map((segment, index) =>
        segment.type === "chip" ? (
          <ReferenceChip key={index} reference={segment.reference} />
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </p>
  );
}
