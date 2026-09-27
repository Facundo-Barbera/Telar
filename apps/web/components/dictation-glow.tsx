import type { DictationPhase } from "@/lib/dictation/use-dictation";

/**
 * THE COMPOSER LIGHTS UP WHILE IT LISTENS — Siri's edge glow, drawn around the
 * one box the words are landing in rather than the whole window.
 *
 * Two layers, always mounted so the fade is a transition rather than a mount:
 * a blurred halo that sits BEHIND the card and spills past its edge, and a thin
 * ring that sits ON the card's border. The parent must be `relative`, and must
 * render the halo before the card and the ring after it — normal paint order is
 * the whole stacking mechanism, as it is for the banner stack.
 *
 * Faint while the microphone is being asked for, full once audio is going up.
 * The colours and the spin live in globals.css (`.dictation-glow`).
 */
export function DictationGlow({ phase, layer }: { phase: DictationPhase; layer: "halo" | "ring" }) {
  return <span aria-hidden data-phase={phase} className={`dictation-glow dictation-glow-${layer}`} />;
}
