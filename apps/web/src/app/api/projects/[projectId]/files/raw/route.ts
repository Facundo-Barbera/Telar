import { engineClient, engineRoute, invalidRequest, bytesResponse } from "@/platform/engine/server";

/**
 * The project twin of the session raw route — one file's bytes out of the
 * project's own checkout, for the pre-session canvas. Same fence, same
 * `no-store` reasoning: a workspace file changes under its own name.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  if (!target) throw invalidRequest("a file path is required");
  const { data, contentType } = await (await engineClient()).projectFileBytes(projectId, target);
  return bytesResponse({ data, contentType });
});
