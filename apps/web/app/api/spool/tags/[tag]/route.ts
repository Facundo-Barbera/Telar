import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ tag: string }> };

/**
 * RENAME A TAG — everywhere it appears, items and notes both. Renaming onto a
 * name already in use MERGES the two labels into one (see
 * `apps/engine/src/spool/tags.ts`'s file header for why that is not a second
 * verb). The engine refuses a blank `to` or an identical from/to with its own
 * sentence.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { tag } = await context.params;
    const body = await requestObject(request);
    const to = typeof body.to === "string" ? body.to : "";
    if (!to.trim()) {
      return Response.json({ error: "to is required — the name the tag should read after the rename." }, { status: 400 });
    }
    return Response.json(await (await engineClient()).renameSpoolTag(tag, to));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
