import { notFound } from "next/navigation";
import { MathSamples } from "./samples";

/**
 * A DEVELOPMENT-ONLY GALLERY of every TeX case the transcript can be handed —
 * the reported study-guide equations, display and inline math, an aligned
 * environment, a matrix, an equation too wide for its column, currency,
 * escaped dollars, literal code, a half-streamed fragment and TeX that cannot
 * parse — at full width and at a narrow measure, side by side.
 *
 * It renders through `MessageResponse`, the same component every conversation
 * surface uses, so what is looked at here is what a message renders.
 *
 * 404 in production: a gallery is not a product screen.
 */
export const dynamic = "force-static";

export default function MathSamplesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MathSamples />;
}
