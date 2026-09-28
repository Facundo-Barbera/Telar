import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * Run the retention sweep now — issue #542.
 *
 * THE DISTINCT VISIBLE ACT, and that is the design rather than a convenience.
 * The first sweep after somebody chooses a window is the whole backlog, and
 * what it does is irreversible in the database; making it something the next
 * startup did quietly is the one shape the approved design rules out.
 *
 * SLOW, AND IT RETURNS COUNTS RATHER THAN BYTES. Each qualifying session is
 * exported and then dropped in a transaction of its own. A DELETE moves pages
 * to sqlite's freelist — the store weighs the same afterwards, and Reclaim is
 * the button that changes that.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).sweepRetention());
});
