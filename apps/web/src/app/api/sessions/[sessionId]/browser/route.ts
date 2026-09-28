import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * What the session's browser is looking at, pixels included.
 *
 * BOTH FLAGS ARE OPT-IN AND FORWARDED VERBATIM, because both cost something the
 * caller has to choose to pay: a screenshot is a round trip through Chromium,
 * and `start` LAUNCHES one. A panel that polled with `start=1` would open a
 * browser for every session a human merely glanced at.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const result = await (await engineClient()).browserState(sessionId, {
      screenshot: url.searchParams.get("screenshot") === "1",
      start: url.searchParams.get("start") === "1",
    });
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
