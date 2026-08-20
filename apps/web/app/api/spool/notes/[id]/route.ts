import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(await (await engineClient()).spoolNote(id));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Edit a note — title, body, tags. FORWARDED WHOLE, the item PATCH's own
 * reasoning: the engine refuses a forbidden key BY NAME (`author` never
 * changes on edit — provenance survives the user touching a tag; a retired
 * note refuses edits with its sentence), and filtering here would turn those
 * refusals into silent no-ops.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const patch = await requestObject(request);
    return Response.json(await (await engineClient()).updateSpoolNote(id, patch));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
