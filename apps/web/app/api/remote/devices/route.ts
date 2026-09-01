import { readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { remoteErrorResponse } from "@/lib/remote/http";
import { readRemote, revokeOtherDevices } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The lost-phone button: revoke every device EXCEPT the caller. The caller is
 * identified from its own credential — no id parameter, so the request cannot
 * be mis-aimed. 401 when the caller can't be identified (with the gate off,
 * an unpaired local browser has no device to keep).
 */
export function DELETE(request: Request) {
  try {
    const file = readRemote();
    const caller = identifyCaller(
      { authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) },
      file,
    );
    if (!caller) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: "This device isn't paired, so there is nothing to keep." } },
        { status: 401 },
      );
    }
    return Response.json({ revoked: revokeOtherDevices(caller.id) });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
