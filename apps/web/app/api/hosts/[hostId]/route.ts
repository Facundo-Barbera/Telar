import { remoteErrorResponse } from "@/lib/remote/http";
import { publicHost, removeStoredHost, renameStoredHost } from "@/lib/hosts/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ hostId: string }> };

/** Rename one host. The name is this cockpit's label for it — the other Mac
 *  is never told. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { hostId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body.name !== "string") {
      return Response.json({ error: { code: "invalid_request", message: "Provide a name." } }, { status: 400 });
    }
    const host = renameStoredHost(hostId, body.name);
    if (!host) return Response.json({ error: { code: "not_found", message: "No such host." } }, { status: 404 });
    return Response.json({ host: publicHost(host) });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

/**
 * Forget a host. The device token stays valid over there until that cockpit
 * revokes it from its own Devices list — this cockpit has no standing to
 * revoke a credential another machine issued, and pretending to would leave
 * a row there that reads as connected.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { hostId } = await context.params;
    if (!removeStoredHost(hostId)) {
      return Response.json({ error: { code: "not_found", message: "No such host." } }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
