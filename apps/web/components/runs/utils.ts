// Run-page helpers. Duplicated here (not shared) so the Runs pages own their
// own formatting and never collide with a sibling agent's files.
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

export function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Coarse duration for elapsed / attempt spans (seconds → m s → h m).
export function fmtDuration(ms: number): string {
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
};
