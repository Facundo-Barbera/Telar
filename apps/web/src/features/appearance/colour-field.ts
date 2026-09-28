
import { parseCssColor } from "./theme-palettes";

const BARE_HEX = /^([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

export function normaliseColourText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = parseCssColor(BARE_HEX.test(trimmed) ? `#${trimmed}` : trimmed);
  return parsed?.toLowerCase();
}
