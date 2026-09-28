
import { normaliseColourText } from "./colour-field";

export const RECENT_COLOUR_LIMIT = 8;

export function rememberColour(list: readonly string[], colour: string): string[] {
  const hex = normaliseColourText(colour);
  if (!hex) return [...list];
  return [hex, ...list.filter((entry) => entry !== hex)].slice(0, RECENT_COLOUR_LIMIT);
}

export type ColourChip = { color: string; label: string };

export function colourChips(input: { light: string; dark: string; accent: string; recent: readonly string[] }): ColourChip[] {
  const named: ColourChip[] = [
    { color: input.light, label: "Light base" },
    { color: input.dark, label: "Dark base" },
    { color: input.accent, label: "Accent" },
  ];
  const chips: ColourChip[] = [];
  const seen = new Set<string>();
  for (const chip of named) {
    const hex = normaliseColourText(chip.color);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    chips.push({ color: hex, label: chip.label });
  }
  for (const colour of input.recent) {
    const hex = normaliseColourText(colour);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    chips.push({ color: hex, label: hex });
  }
  return chips;
}

const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let recent: readonly string[] = EMPTY;

export function rememberStopColour(colour: string): void {
  const next = rememberColour(recent, colour);
  if (next.length === recent.length && next.every((entry, index) => entry === recent[index])) return;
  recent = next;
  for (const listener of listeners) listener();
}

export function subscribeRecentColours(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentColoursSnapshot(): readonly string[] {
  return recent;
}

export function serverRecentColoursSnapshot(): readonly string[] {
  return EMPTY;
}

export function forgetRecentColours(): void {
  recent = EMPTY;
}
