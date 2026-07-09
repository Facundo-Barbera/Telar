// Run-specific helpers — state predicates, cost summing, and the duration
// formatters the run views need. Cross-surface formatters (fmtAgo, fmtCost,
// shortId) live in @/lib/format so every page shares one language.
import type { AttemptRecord, RunKind, WorkUnitState } from "@telar/core";

const TERMINAL: readonly WorkUnitState[] = [
  "done",
  "needs-review",
  "halted",
  "failed",
  "skipped",
];

export const isTerminal = (s: WorkUnitState): boolean => TERMINAL.includes(s);
export const isActive = (s: WorkUnitState): boolean =>
  s === "running" || s === "verifying" || s === "preparing";

export function sumCost(attempts: AttemptRecord[]): number {
  return attempts.reduce((total, a) => total + (a.costUsd ?? 0), 0);
}

// Coarse duration for elapsed / attempt spans (seconds → m s → h m).
// Guards non-finite input (NaN from a missing/invalid timestamp) so the header
// degrades to "—" instead of rendering "NaNh NaNm".
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Fine-grained duration for gate runtimes (kept in ms until it's a second).
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const KIND_INFO: Record<RunKind, { label: string; blurb: string }> = {
  quickfix: {
    label: "Quickfix",
    blurb: "A small, surgical change — one focused fix, verified fast.",
  },
  story: {
    label: "Story",
    blurb: "A larger feature — builds across files, then proves itself.",
  },
  custom: {
    label: "Custom",
    blurb: "Freeform — you write the whole brief.",
  },
  verify: {
    label: "Verify",
    blurb:
      "Read-only — drive a running/deployed URL and judge its acceptance criteria. No code changes.",
  },
};
