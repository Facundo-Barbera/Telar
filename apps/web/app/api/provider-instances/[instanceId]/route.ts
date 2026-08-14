import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/** Removing a login forgets how it was configured; it does not touch the
 *  folder it named, and it does not sign anything out. The engine refuses the
 *  built-in slot with a 409. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ instanceId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { instanceId } = await context.params;
    return Response.json(await (await engineClient()).removeProviderInstance(instanceId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
