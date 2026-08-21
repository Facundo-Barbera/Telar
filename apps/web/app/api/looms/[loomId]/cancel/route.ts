import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/** Stop a loom. NO BODY: cancelling is not a decision with options, and a
 *  reason field here would be a second way to say what the ledger records. */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    return Response.json(await (await engineClient()).cancelLoom(loomId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
