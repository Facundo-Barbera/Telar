import { remoteErrorResponse } from "@/lib/remote/http";
import { renameDevice, revokeDevice, setDeviceRole, RemoteStoreError, type PairedDevice } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ deviceId: string }> };

function publicDevice({ id, name, createdAt, lastSeenAt, role, platform }: PairedDevice) {
  return { id, name, createdAt, lastSeenAt, role, platform };
}

/** Rename and/or re-role one device. Demoting the last full device is 409. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { deviceId } = await context.params;
    const body = (await request.json()) as { name?: unknown; role?: unknown };
    const name = typeof body.name === "string" ? body.name : undefined;
    const role = body.role === "full" || body.role === "observer" ? body.role : undefined;
    if (name === undefined && role === undefined) {
      return Response.json(
        { error: { code: "invalid_request", message: "Provide a name and/or a role of full|observer." } },
        { status: 400 },
      );
    }
    let device: PairedDevice | undefined;
    if (name !== undefined) device = renameDevice(deviceId, name);
    if (role !== undefined) {
      try {
        device = setDeviceRole(deviceId, role);
      } catch (error) {
        if (error instanceof RemoteStoreError) {
          return Response.json({ error: { code: "cockpit_last_full_device", message: error.message } }, { status: 409 });
        }
        throw error;
      }
    }
    if (!device) {
      return Response.json({ error: { code: "not_found", message: "No such device." } }, { status: 404 });
    }
    return Response.json({ device: publicDevice(device) });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

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
