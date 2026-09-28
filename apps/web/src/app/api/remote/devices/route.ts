import { identifyCaller } from "@/features/remote/server";
import { engineErrorResponse, engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request) {
  try {
    const caller = (await identifyCaller(request)).device;
    if (!caller) {
      return Response.json(
        { error: { code: "cockpit_unauthorized", message: "This device isn't paired, so there is nothing to keep." } },
        { status: 401 },
      );
    }
    return engineForward(request, `/v2/remote/devices?keep=${encodeURIComponent(caller.id)}`);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
