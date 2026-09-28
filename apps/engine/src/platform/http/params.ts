import { HttpError } from "./http";

export function stringValue(value: unknown, label: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", `${label} must be a string`);
  return value;
}

/** A non-negative integer query parameter, clamped to `ceiling`; anything that isn't one is refused, never defaulted. */
export function positiveParam(raw: string | null, fallback: number, ceiling: number, label: string): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "invalid_request", `${label} must be a non-negative integer`);
  return Math.min(value, ceiling);
}
