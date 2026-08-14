/**
 * WHAT A REFERENCE CHIP LOOKS LIKE — in one place, because two surfaces draw it.
 *
 * The composer builds chips imperatively (a `contenteditable` needs real DOM
 * nodes it can put a caret between); the transcript builds them as React. Same
 * pixels, two mechanisms — which is exactly the shape that drifts if each keeps
 * its own copy of the class list.
 *
 * Ported from t3 code's `composerInlineChip.ts`, metrics included. EVERY
 * MEASUREMENT IS IN `em`, which is the part worth copying: a chip has to scale
 * with the prose it sits inside, and one pinned to 12px inside 15px text sits
 * visibly low and breaks the line's rhythm.
 */
import { chipPath } from "./composer-tokens";
import type { TelarReference } from "./drag-reference";

export const CHIP_CLASS =
  "inline-flex max-w-full select-none items-center gap-[0.33em] rounded-[0.5em] border border-border/70 bg-accent/40 px-[0.5em] py-[0.08em] align-middle text-[0.86em] font-medium leading-[1.1] text-foreground";
export const CHIP_ICON_CLASS = "size-[1.17em] shrink-0";
export const CHIP_LABEL_CLASS = "truncate leading-tight";

/** Longest tooltip a chip will carry. A failing check's reference is a
 *  paragraph, and a tooltip the height of the screen is not a tooltip. */
const MAX_CHIP_TITLE = 300;

/**
 * The full text behind the chip, for the tooltip.
 *
 * A FILE SHOWS ITS PATH, not its reference text: the reference is the path
 * wrapped in backticks, and a tooltip that renders the punctuation is telling
 * you about the syntax rather than about the file.
 */
export function chipTitle(reference: TelarReference): string {
  const full = reference.kind === "file" ? chipPath(reference) : reference.text;
  return full.length > MAX_CHIP_TITLE ? `${full.slice(0, MAX_CHIP_TITLE)}…` : full;
}
