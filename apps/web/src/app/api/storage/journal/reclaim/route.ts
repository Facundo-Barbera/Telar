import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Compact the turn journal and give its freed pages back — issue #646.
 *
 * THE STORAGE PANE'S ONLY WRITE, and a POST because of it. #642 built that pane
 * read-and-reveal deliberately; what makes an action defensible here is that
 * nothing it removes is history. It drops the streaming rows whose own
 * `item.completed` already carries their text, then vacuums the database.
 *
 * SLOW AND EXCLUSIVE. The vacuum rewrites the file under a lock — seconds on a
 * large store — and there is no honest before-and-after without waiting for it.
 * That is precisely why this is a button and not something startup does.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await (await engineClient()).reclaimJournal());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
