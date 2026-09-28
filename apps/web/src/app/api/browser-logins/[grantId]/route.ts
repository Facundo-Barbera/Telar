import { engineClient, engineRoute } from "@/platform/engine/server";

/** Take one remembered login back. The next fill of that item asks again. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ grantId: string }> };

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { grantId } = await context.params;
  return Response.json(await (await engineClient()).revokeBrowserLogin(grantId));
});
