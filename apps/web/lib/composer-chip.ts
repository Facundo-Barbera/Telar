/**
 * Shared chip styling: the composer builds chips as DOM nodes, the transcript as
 * React. Every measurement is in `em` so a chip scales with the prose around it.
 */
import { chipPath } from "./composer-tokens";
import type { TelarReference } from "./drag-reference";

export const CHIP_CLASS =
  "inline-flex max-w-full select-none items-center gap-[0.33em] rounded-[0.5em] border border-border/70 bg-accent/40 px-[0.5em] py-[0.08em] align-middle text-[0.86em] font-medium leading-[1.1] text-foreground";
export const CHIP_ICON_CLASS = "size-[1.17em] shrink-0";
export const CHIP_LABEL_CLASS = "truncate leading-tight";

const MAX_CHIP_TITLE = 300;

/** Tooltip text; a file shows its path, not the backticked reference. */
export function chipTitle(reference: TelarReference): string {
  const full = reference.kind === "file" ? chipPath(reference) : reference.text;
  return full.length > MAX_CHIP_TITLE ? `${full.slice(0, MAX_CHIP_TITLE)}…` : full;
}
