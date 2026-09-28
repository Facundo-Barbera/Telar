import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Ask macOS for the grants and open the Settings pane to finish in, answering
 *  what happened. The dialogs name Telar's bundled helper, or an external cua
 *  install in dev. */
export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).grantComputerUseAccess());
});
