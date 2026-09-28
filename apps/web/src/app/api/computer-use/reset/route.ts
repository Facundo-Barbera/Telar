import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Clear the macOS grants of Telar's bundled computer-use helper, and only
 *  its; `{ reset: false }` when there is no bundled helper to reset. */
export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).resetComputerUseAccess());
});
