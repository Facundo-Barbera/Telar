import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

/**
 * A project's identity, its conversation defaults and its opt-in switches. Thin
 * proxy: the engine validates every block and refuses unknown keys, so this only
 * forwards what arrived under the names the contract knows.
 *
 * `null` IS A VALUE HERE, NOT AN ABSENCE, which is why each arm tests
 * `"field" in body` rather than truthiness. `dataScience: null` is how "off"
 * travels; `envMode: null` is how "follow this Mac's standing answer" travels.
 * A `!body.envMode` check would have dropped both on the floor and left the pane
 * unable to undo a choice it had just made.
 *
 * THE GENERIC `plugins` ARM TRAVELS TOO, and its absence here was a real hole: a
 * plugin with no legacy field of its own — anything after data-science and
 * LaTeX — could be toggled by the project's own page (which calls the engine
 * client directly) and not through this route, so the same switch worked on one
 * surface and silently did nothing on the other.
 */
type ProjectPatch = Parameters<Awaited<ReturnType<typeof engineClient>>["updateProject"]>[1];

export async function PATCH(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const body = await requestObject(request);
    const patch: ProjectPatch = {};
    for (const field of ["name", "iconName", "iconEmoji", "defaultModel", "envMode", "dataScience", "latex", "plugins"] as const) {
      if (field in body) (patch as Record<string, unknown>)[field] = body[field];
    }
    return Response.json(await (await engineClient()).updateProject(projectId, patch));
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
