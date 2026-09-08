import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/**
 * A project's opt-in switches. Thin proxy: the engine validates the block and
 * refuses unknown keys, so this only forwards what arrived under the names the
 * contract knows. `dataScience: null` / `latex: null` is how "off" travels.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    const patch: { dataScience?: null | Record<string, unknown>; latex?: null | Record<string, unknown> } = {};
    if ("dataScience" in body) patch.dataScience = body.dataScience as null | Record<string, unknown>;
    if ("latex" in body) patch.latex = body.latex as null | Record<string, unknown>;
    return Response.json(await (await engineClient()).updateProject(projectId, patch as Parameters<Awaited<ReturnType<typeof engineClient>>["updateProject"]>[1]));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Unregister. A DELETE ON THE REGISTRATION, not on the project — the engine
 * removes the registry entry and touches nothing on disk. Thin proxy: the
 * engine owns the refusal when a session on this project is mid-turn, and
 * `engineErrorResponse` carries its 409 through unchanged.
 */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await engineClient()).unregisterProject(projectId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
