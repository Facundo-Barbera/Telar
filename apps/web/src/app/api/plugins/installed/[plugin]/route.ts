import { engineClient, engineErrorResponse } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ plugin: string }> };

/** Stop an installed plugin and remove its folder. */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { plugin } = await context.params;
    return Response.json(await (await engineClient()).uninstallPlugin(plugin));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
