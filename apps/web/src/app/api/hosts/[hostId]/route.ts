import { engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ hostId: string }> };

const hostPath = async (context: Context) => `/v2/hosts/${encodeURIComponent((await context.params).hostId)}`;

export async function PATCH(request: Request, context: Context) {
  return engineForward(request, await hostPath(context));
}

export async function DELETE(request: Request, context: Context) {
  return engineForward(request, await hostPath(context));
}
