import { LoomDeck } from "@/components/loom/deck";

/**
 * THE DECK — every loom in every project, one page, no segments. This is the
 * one view at this address, so there is nothing to choose between.
 *
 * A thin server component over a client one: the whole surface is a live
 * snapshot on two cadences (`lib/loom-overview.ts`), so there is nothing useful
 * for the server to resolve first and everything to gain from the page not
 * being cached.
 *
 * `/looms/orchestrator` USED TO BE A HARDCODED MOCKUP and is now a redirect to
 * this page — see that file.
 */
export const dynamic = "force-dynamic";

export default function LoomsPage() {
  // The deck is a flex CHILD everywhere it appears — here and as the `Deck`
  // segment of a project — so the page owns the window height and the component
  // owns nothing but its own column.
  return (
    <div className="flex h-dvh min-w-0 overflow-hidden">
      <LoomDeck />
    </div>
  );
}
