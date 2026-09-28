import { enginePipe, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ hostId: string; path: string[] }> };

const handle = engineRoute(async (request: Request, context: Context) => {
  const { hostId, path } = await context.params;
  const tail = path.map(encodeURIComponent).join("/");
  return enginePipe(request, `/v2/hosts/${encodeURIComponent(hostId)}/api/${tail}${new URL(request.url).search}`);
});

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
