import type { Loom, LoomProgram, Rung } from "@telar/engine-client";

/**
 * WHAT WAS ALREADY TRIED, so the human is answering a question rather than
 * doing triage.
 *
 * A loom only reaches a person after the ladder is spent. The row that asks
 * therefore has to say which rungs ran — otherwise the first thing the reader
 * does at 8am is guess whether the obvious cheap thing was attempted, which is
 * the work the ladder exists to have already done.
 *
 * `absorbed` IS A LIFETIME COUNT, NOT THIS LOOM'S. It is how many stuck looms
 * that rung has ever resolved, and it is the number that says whether the
 * ladder is any good. Showing it beside a rung that just failed is the point:
 * "rung 2 has rescued four of these and still could not rescue this one" is a
 * far more useful sentence than "rung 2 failed".
 */
export type LadderStep = {
  n: number;
  label: string;
  enabled: boolean;
  /** Lifetime: stuck looms this rung has resolved. */
  absorbed: number;
  /** Ran on THIS loom. */
  tried: boolean;
};

/**
 * The ladder as it stands for one loom.
 *
 * Rungs run in order, cheapest first, disabled ones skipped, each once. So a
 * rung was tried exactly when it is enabled and sits at or below the rung the
 * loom last reached. Disabled rungs are still returned — an off rung is a
 * choice the human made, and a row that hides it cannot show them that the
 * thing they turned off is the thing that would have caught this.
 */
export function ladderTrace(ladder: readonly Rung[], loom: Pick<Loom, "ladderRung">): LadderStep[] {
  return [...ladder]
    .sort((left, right) => left.n - right.n)
    .map((rung) => ({
      n: rung.n,
      label: rung.label,
      enabled: rung.enabled,
      absorbed: rung.absorbed,
      tried: rung.enabled && rung.n <= loom.ladderRung,
    }));
}

/**
 * One sentence for the row's header. Written for the case that actually
 * happens: it reached you because everything cheap was already spent.
 */
export function ladderSummary(steps: readonly LadderStep[]): string {
  const enabled = steps.filter((step) => step.enabled);
  const tried = steps.filter((step) => step.tried);
  if (enabled.length === 0) return "Your ladder is empty, so nothing was tried before this reached you.";
  if (tried.length === 0) return `Nothing was tried — ${enabled.length} rungs are on, and none of them ran.`;
  const absorbed = tried.reduce((total, step) => total + step.absorbed, 0);
  const rungs = `${tried.length} of ${enabled.length} rungs ran`;
  return absorbed === 0
    ? `${rungs}, and none of them has ever absorbed anything — the ladder may be the problem.`
    : `${rungs} and could not absorb it; between them they have absorbed ${absorbed} before.`;
}

/** Total absorbed across the enabled rungs — the ladder's own scoreboard. */
export function ladderAbsorbed(program: Pick<LoomProgram, "ladder"> | null | undefined): number {
  return (program?.ladder ?? []).filter((rung) => rung.enabled).reduce((total, rung) => total + rung.absorbed, 0);
}
