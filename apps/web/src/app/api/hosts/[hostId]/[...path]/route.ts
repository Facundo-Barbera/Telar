import { remoteErrorResponse } from "@/lib/remote/http";
import { findHost } from "@/lib/hosts/store";
import { forward } from "@/lib/hosts/proxy";

/**
 * `/api/hosts/:id/*` → that Mac's `/api/*`, with its token. The rules are in
 * lib/hosts/proxy.ts; this only looks the host up.
 *
 * GATED LIKE EVERYTHING ELSE under `/api` (proxy.ts): a device that may only
 * observe THIS cockpit may only observe through it, whatever its standing
 * over there.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ hostId: string; path: string[] }> };

async function handle(request: Request, context: Context): Promise<Response> {
  try {
    const { hostId, path } = await context.params;
    const host = findHost(hostId);
    if (!host) return Response.json({ error: { code: "not_found", message: "No such host." } }, { status: 404 });
    return await forward(request, host, path);
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
