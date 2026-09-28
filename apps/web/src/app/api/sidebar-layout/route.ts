import type { SidebarMode } from "@telar/engine-client";
import { requestObject, engineClient, engineRoute } from "@/platform/engine/server";

/**
 * Where each project group sits in the rail — the order the reader dragged
 * them into.
 *
 * ENVIRONMENT-SCOPED, like the inbox rule beside it: the desktop shell, a
 * browser tab and a paired phone all draw this engine's rail, and an
 * arrangement that differed between them would be one you had to redo per
 * window.
 *
 * FORWARDED UNVALIDATED, also like the inbox rule: the shape and the cap live
 * next to the schema in the engine, and a second copy here could disagree.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).sidebarLayout());
});

export const PATCH = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  return Response.json(
    await (await engineClient()).setSidebarLayout({
      ...("projectOrder" in body ? { projectOrder: body.projectOrder as string[] } : {}),
      ...("sessionOrder" in body ? { sessionOrder: body.sessionOrder as Record<string, string[]> } : {}),
      ...("pinnedOrder" in body ? { pinnedOrder: body.pinnedOrder as string[] } : {}),
      ...("mode" in body ? { mode: body.mode as SidebarMode } : {}),
    }),
  );
});
