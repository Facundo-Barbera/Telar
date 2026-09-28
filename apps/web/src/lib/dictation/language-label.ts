import { DICTATION_AUTOMATIC } from "./automatic";

export const DICTATION_AUTOMATIC_BADGE = "AUTO";

export function languageBadge(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return DICTATION_AUTOMATIC_BADGE;
  return trimmed === DICTATION_AUTOMATIC ? DICTATION_AUTOMATIC_BADGE : trimmed.toUpperCase();
}
