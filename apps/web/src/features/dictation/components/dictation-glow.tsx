import type { DictationPhase } from "../hooks/use-dictation";

/** Keep both layers mounted in a `relative` parent: the halo before the card, the ring after it. Styles live in globals.css. */
export function DictationGlow({ phase, layer }: { phase: DictationPhase; layer: "halo" | "ring" }) {
  return <span aria-hidden data-phase={phase} className={`dictation-glow dictation-glow-${layer}`} />;
}
