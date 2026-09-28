import { engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ deviceId: string }> };

const devicePath = async (context: Context) => `/v2/remote/devices/${encodeURIComponent((await context.params).deviceId)}`;

export async function PATCH(request: Request, context: Context) {
  return engineForward(request, await devicePath(context));
}

export async function DELETE(request: Request, context: Context) {
  return engineForward(request, await devicePath(context));
}
