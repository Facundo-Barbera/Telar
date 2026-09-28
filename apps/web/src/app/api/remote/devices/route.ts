import { readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { remoteErrorResponse } from "@/lib/remote/http";
import { readRemote } from "@/lib/remote/store";
import { engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function DELETE(request: Request) {
  try {
    const caller = identifyCaller(
      { authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) },
      readRemote(),
    );
    if (!caller) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: "This device isn't paired, so there is nothing to keep." } },
        { status: 401 },
      );
    }
    return engineForward(request, `/v2/remote/devices?keep=${encodeURIComponent(caller.id)}`);
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
