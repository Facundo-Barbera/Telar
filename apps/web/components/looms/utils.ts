// Loom-specific helpers — state predicates, cost summing, and the duration
// formatters the loom views need. Cross-surface formatters (fmtAgo, fmtCost,
// shortId) live in @/lib/format so every page shares one language.
import type { AttemptRecord, Charter, Loom, LoomKind, WorkUnitState } from "@telar/core";

// Derived CLIENT-SIDE on purpose: importing isWoven from @telar/core drags the
// core barrel (engine.ts → the Node-only Agent SDK, which needs async_hooks)
// into the browser bundle and breaks the build. A loom/charter is "woven"
// (orchestrates threads) when its Charter carries a non-empty decomposition.
export function isWoven(x: Loom | Charter | null | undefined): boolean {
  const d =
    (x as Charter | undefined)?.decomposition ??
    (x as Loom | undefined)?.charter?.decomposition;
  return (d?.length ?? 0) > 0;
}

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
// Waiting on the human — not doing autonomous work, but not closed either
// (ready keeps its event stream open for steering; blocked needs a decision).
export const isAwaitingOwner = (s: WorkUnitState): boolean =>
  s === "ready" || s === "blocked";

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

// The SAME color vocabulary StateBadge owns (sky=running/preparing,
// violet=verifying, primary=done, emerald=ready, amber=needs-review,
// orange=blocked, destructive=failed, muted=everything else) — a thin local
// variant, not a new palette, so every state rail (thread rows, loom cards)
// reads off one shared definition.
export function stateRailClass(state: WorkUnitState): string {
  switch (state) {
    case "preparing":
    case "running":
      return "bg-sky-400";
    case "verifying":
      return "bg-violet-400";
    case "ready":
      return "bg-emerald-400";
    case "done":
      return "bg-primary";
    case "needs-review":
      return "bg-amber-400";
    case "blocked":
      return "bg-orange-400";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

// A loom's kind-of-loom, independent of its state: woven (spawns threads),
// verify (read-only judgment, no writes), or single (does the work itself).
// docs/loom-model.md §W — "epic-ness" is not a stored type; woven is derived
// structurally via isWoven (a non-empty Charter.decomposition). kind ===
// "verify" is the fallback signal for looms that don't weave.
export function loomRole(loom: Loom): "woven" | "verify" | "single" {
  if (isWoven(loom)) return "woven";
  if (loom.kind === "verify") return "verify";
  return "single";
}

// Thread count for a woven loom's weave chip, read straight off the root
// loom's already-fetched Charter — zero extra requests. null means "unknown,
// no charter yet" (queued/scoping loom), distinct from 0 threads.
//
// TODO: this undercounts orphan threads (children spawned under a prior
// charter revision, no longer in `decomposition` — see thread-tree.tsx) since
// resolving that needs the live /api/looms/[id]/threads fetch weave-god-view
// is allowed to make per-loom page. Do NOT "fix" this by looping
// listChildLooms() inside the list route — that just moves the N+1 fetch
// server-side instead of eliminating it. A batch-computed childCounts field
// written into loom.json on state change (or an opt-in query param on
// GET /api/looms) is the real fix, if this gap ever matters enough.
export function threadCount(loom: Loom): number | null {
  return loom.charter?.decomposition?.length ?? null;
}

export const KIND_INFO: Record<LoomKind, { label: string; blurb: string }> = {
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
