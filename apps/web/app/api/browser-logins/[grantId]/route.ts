import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/** Take one remembered login back. The next fill of that item asks again. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ grantId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { grantId } = await context.params;
    return Response.json(await (await engineClient()).revokeBrowserLogin(grantId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
