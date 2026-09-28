import { engineClient, engineRoute, invalidRequest } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; taskId: string }> };

/** A page of a background task's log — the Processes tab's row. `after` is a
 *  byte cursor; absent asks for the tail. */
export const GET = engineRoute(async (request: Request, context: Context) => {
  const { sessionId, taskId } = await context.params;
  const raw = new URL(request.url).searchParams.get("after");
  const after = raw === null ? undefined : Number(raw);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw invalidRequest("after must be a byte offset");
  return Response.json(await (await engineClient()).taskOutput(sessionId, taskId, after));
});
