import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/** A human resumes a paused session; its held backlog runs in order. */
export async function POST(_request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    return Response.json(await (await engineClient()).resumeSession(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
