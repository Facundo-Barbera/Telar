import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Show Telar's bundled computer-use helper in Finder, so it can be dragged
 *  into a Privacy & Security list that does not name it yet. */
export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).revealComputerUseHelper());
});
