import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; attachmentId: string }> };

/** The bytes behind an attachment. Immutable per id, so the browser may cache. */
export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { sessionId, attachmentId } = await context.params;
  const { data, contentType } = await (await engineClient()).attachmentBytes(sessionId, attachmentId);
  return new Response(new Uint8Array(data).buffer as ArrayBuffer, { headers: { "content-type": contentType, "cache-control": "private, max-age=31536000, immutable" } });
});

/** Replace the tags — how a plot is pinned. */
export const PATCH = engineRoute(async (request: Request, context: Context) => {
  const { sessionId, attachmentId } = await context.params;
  const body = await requestObject(request);
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
  return Response.json(await (await engineClient()).tagAttachment(sessionId, attachmentId, tags));
});
