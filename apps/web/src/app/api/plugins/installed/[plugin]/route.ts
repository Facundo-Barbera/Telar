import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ plugin: string }> };

/** Stop an installed plugin and remove its folder. */
export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { plugin } = await context.params;
  return Response.json(await (await engineClient()).uninstallPlugin(plugin));
});
