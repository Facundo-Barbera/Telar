/**
 * Issue and PR details open inside their list surface's sub-strip, stored in the
 * tab's flat `params` (`{ open: "675,666", at: "675" }`). Nothing open writes no
 * keys.
 */

import type { PanelTabParams } from "@/lib/right-panel-tabs";

/** `at` absent means the list is showing. */
export type ForgeOpen = {
  /** Strip order, left to right. */
  numbers: readonly number[];
  /** Always one of `numbers`, or absent for the list. */
  at?: number;
};

export function emptyForge(): ForgeOpen {
  return { numbers: [] };
}

const OPEN_KEY = "open";
const AT_KEY = "at";

/** A positive integer, or nothing. */
function forgeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/** Validated: duplicates collapse, bad numbers drop, and an `at` not open falls back to the list. */
export function readForgeOpen(params: PanelTabParams): ForgeOpen {
  const numbers: number[] = [];
  for (const part of (params[OPEN_KEY] ?? "").split(",")) {
    const number = forgeNumber(part.trim());
    if (number !== undefined && !numbers.includes(number)) numbers.push(number);
  }
  const at = forgeNumber((params[AT_KEY] ?? "").trim());
  return { numbers, ...(at !== undefined && numbers.includes(at) ? { at } : {}) };
}

export function forgeParams(open: ForgeOpen): PanelTabParams {
  if (open.numbers.length === 0) return {};
  return {
    [OPEN_KEY]: open.numbers.join(","),
    ...(open.at !== undefined && open.numbers.includes(open.at) ? { [AT_KEY]: String(open.at) } : {}),
  };
}

/** Opens or focuses; no preview slot, since every open here is deliberate. */
export function openForge(open: ForgeOpen, number: number): ForgeOpen {
  if (open.numbers.includes(number)) return { ...open, at: number };
  return { numbers: [...open.numbers, number], at: number };
}

/** Next shown is the right-hand neighbour, else the new last one, else the list. */
export function closeForge(open: ForgeOpen, number: number): ForgeOpen {
  const index = open.numbers.indexOf(number);
  if (index === -1) return open;
  const numbers = open.numbers.filter((entry) => entry !== number);
  if (numbers.length === 0) return { numbers };
  const at = open.at === number ? (numbers[index] ?? numbers[numbers.length - 1]!) : open.at;
  return { numbers, ...(at !== undefined ? { at } : {}) };
}

/** Unknown numbers are ignored, so a stale click can't select a gone chip. */
export function activateForge(open: ForgeOpen, number: number): ForgeOpen {
  return open.numbers.includes(number) ? { ...open, at: number } : open;
}

/** Rebuilt so `at` is absent, not an explicit `undefined` persisted into `params`. */
export function showForgeList(open: ForgeOpen): ForgeOpen {
  return { numbers: open.numbers };
}

/** Names the numbers to close so there's one close path; see `otherEditorPaths`. */
export function otherForgeNumbers(open: ForgeOpen, number: number): number[] {
  if (!open.numbers.includes(number)) return [];
  return open.numbers.filter((entry) => entry !== number);
}

export function forgeNumbersAfter(open: ForgeOpen, number: number): number[] {
  const index = open.numbers.indexOf(number);
  if (index === -1) return [];
  return open.numbers.slice(index + 1);
}
