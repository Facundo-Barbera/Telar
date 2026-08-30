import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { getLoom } from "@/lib/looms/store";
import { runLoomVerification } from "@/lib/looms/verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ loomId: string }> };

/** The clean-desk gate, from the button. The conductor triggers the exact
 *  same lib — see lib/looms/verify.ts for the rules and the reasons. */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    return Response.json(await runLoomVerification(loom, await engineClient()));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
