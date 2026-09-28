import type { UsageSnapshot } from "@telar/engine-client";
import { asRecord } from "./mapping";

/** Claude reports cumulative usage per assistant message; the result message
 *  carries the authoritative total plus the price. */
export function usageFrom(value: unknown, costUsd: unknown): UsageSnapshot | undefined {
  const usage = asRecord(value);
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  return {
    tokens: {
      input: n(input),
      output: n(output),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheCreate: n(usage.cache_creation_input_tokens),
    },
    ...(typeof costUsd === "number" && costUsd >= 0 ? { costUsd } : {}),
  };
}

export function turnCostFrom(cumulativeUsd: unknown, epoch: { costTotalUsd: number | undefined }): number | undefined {
  if (typeof cumulativeUsd !== "number" || !Number.isFinite(cumulativeUsd) || cumulativeUsd < 0) return undefined;
  const previous = epoch.costTotalUsd;
  if (cumulativeUsd === 0) return previous === undefined ? 0 : undefined;
  epoch.costTotalUsd = cumulativeUsd;
  if (previous === undefined || cumulativeUsd < previous) return cumulativeUsd;
  // Rounded because binary floating point makes 0.3 − 0.1 read as
  // 0.19999999999999998, and a price is not improved by sixteen digits.
  return Math.round((cumulativeUsd - previous) * 1e10) / 1e10;
}

export function contextUsedFrom(value: unknown): number | undefined {
  const usage = asRecord(value);
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return undefined;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.output_tokens);
}

export function contextMaxFrom(value: unknown): number | undefined {
  let max: number | undefined;
  for (const entry of Object.values(asRecord(value))) {
    const window = asRecord(entry).contextWindow;
    if (typeof window === "number" && window > 0) max = Math.max(max ?? 0, window);
  }
  return max;
}
