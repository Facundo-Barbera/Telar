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
import { chipIsDirectory, chipPath, segmentDraft } from "@/lib/composer-tokens";
import { chipGlyphFor } from "@/lib/glyph-paths";
import { cn } from "@/lib/utils";
import type { TelarReference } from "@/lib/drag-reference";
import { filePanelTab, issuePanelTab, pullPanelTab, type PanelTab } from "@/components/right-panel";

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

/**
 * WHICH PANEL TAB A CHIP STANDS FOR, or nothing.
 *
 * THREE OF THE SIX KINDS OPEN, and the other three are not oversights:
 *   - `page` is an arbitrary URL. The browser surface addresses tabs by the
 *     ENGINE's own tab id, which a URL in a message does not carry — there is
 *     nothing to open, only something to guess.
 *   - `task` names a sub-agent by its title. The Agents panel addresses one by
 *     id, and the reference never carried it.
 *   - `check` belongs to a pull request's own view; the panel has no surface
 *     for one on its own.
 *
 * A DIRECTORY DOES NOT OPEN EITHER. The file surface reads a file; pointing it
 * at a directory would either fail or quietly open the tree at the wrong place,
 * and a chip that lands you somewhere adjacent is worse than one that does
 * nothing, because you have to work out where you ended up.
 *
 * The parse is over `text` rather than `label`: the text is the canonical form
 * this cockpit wrote (`drag-reference.ts`), and the label is a shortening of it
 * that exists to be read.
 */
export function panelTabFor(reference: TelarReference): PanelTab | undefined {
  if (reference.kind === "issue") {
    const number = /^#(\d+) /.exec(reference.text);
    return number ? issuePanelTab(Number(number[1])) : undefined;
  }
  if (reference.kind === "pull") {
    const number = /^PR #(\d+) /.exec(reference.text);
    return number ? pullPanelTab(Number(number[1])) : undefined;
  }
  if (reference.kind === "file" && !chipIsDirectory(reference)) return filePanelTab(chipPath(reference));
  return undefined;
}

/**
 * A chip, and — where there is somewhere to go — a button.
 *
 * THE TWO LOOK DIFFERENT ON HOVER, deliberately. Half the kinds here open a
 * panel and half cannot, and a chip that offers a pointer and then does nothing
 * is worse than one that never offered: the reader learns the gesture is
 * unreliable and stops trying it on the ones that work.
 */
function ReferenceChip({ reference, onOpen }: { reference: TelarReference; onOpen?: (tab: PanelTab) => void }) {
  const { markup, tint } = chipGlyphFor(reference);
  const tab = onOpen ? panelTabFor(reference) : undefined;
  const body = (
    <>
      <ChipGlyph markup={markup} className={cn(CHIP_ICON_CLASS, tint)} />
      <span className={CHIP_LABEL_CLASS}>{reference.label}</span>
    </>
  );
  if (!tab) {
    return (
      <span className={CHIP_CLASS} title={chipTitle(reference)}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      // The full reference is the tooltip everywhere; here it gains the verb,
      // because a chip that acts has to say what pressing it does.
      title={`Open — ${chipTitle(reference)}`}
      className={cn(CHIP_CLASS, "cursor-pointer transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
      onClick={() => onOpen?.(tab)}
    >
      {body}
    </button>
  );
}

/**
 * `whitespace-pre-wrap` STAYS ON THE PARAGRAPH. The prompt is what a person
 * typed, newlines included, and a chip is inline inside it — so the wrapping
 * rule belongs to the block, not to each run.
 */
export function PromptText({
  text,
  className,
  onOpen,
}: {
  text: string;
  className?: string;
  /** Makes the openable kinds pressable. Absent — on a surface with no panel to
   *  open — and every chip is a label again, which is the honest fallback. */
  onOpen?: (tab: PanelTab) => void;
}) {
  return (
    <p className={cn("whitespace-pre-wrap", className)}>
      {segmentDraft(text).map((segment, index) =>
        segment.type === "chip" ? (
          <ReferenceChip key={index} reference={segment.reference} {...(onOpen ? { onOpen } : {})} />
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </p>
  );
}
