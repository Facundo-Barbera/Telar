import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

/**
 * Open a page in the session's browser, as the human. The door a client
 * without a desktop shell — a phone, or a cockpit reading a paired Mac —
 * uses to put a link in front of the agent. Forwarded verbatim; the engine
 * validates the URL and refuses anything but http(s).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).browserOpen(sessionId, requiredString(body.url, "url")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
