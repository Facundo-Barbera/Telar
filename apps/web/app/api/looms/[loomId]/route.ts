import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/** One loom, in full. An id nothing goes by is the engine's `not_found`, which
 *  arrives here as a 404 carrying the engine's own sentence. */
export async function GET(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    return Response.json(await (await engineClient()).loom(loomId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
