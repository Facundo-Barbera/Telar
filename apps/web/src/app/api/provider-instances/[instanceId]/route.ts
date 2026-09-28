import { engineClient, engineRoute } from "@/platform/engine/server";

/** Removing a login forgets how it was configured; it does not touch the
 *  folder it named, and it does not sign anything out. The engine refuses the
 *  built-in slot with a 409. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ instanceId: string }> };

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { instanceId } = await context.params;
  return Response.json(await (await engineClient()).removeProviderInstance(instanceId));
});
