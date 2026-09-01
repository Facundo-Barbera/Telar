import { remoteErrorResponse } from "@/lib/remote/http";
import { revokeDevice } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ deviceId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { deviceId } = await context.params;
    if (!revokeDevice(deviceId)) {
      return Response.json({ error: { code: "not_found", message: "No such device." } }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
