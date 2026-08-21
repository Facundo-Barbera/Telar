import { LoomDeck } from "@/components/loom/deck";

/**
 * THE DECK — every loom, every classification, one page.
 *
 * A thin server component over a client one: the whole surface is a live
 * snapshot on two cadences (`lib/loom-overview.ts`), so there is nothing
 * useful for the server to resolve first and everything to gain from the page
 * not being cached.
 *
 * `/looms/orchestrator` USED TO BE A HARDCODED MOCKUP and is now a redirect to
 * this page — see that file.
 */
export const dynamic = "force-dynamic";

export default function LoomsPage() {
  return <LoomDeck />;
}
