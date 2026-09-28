import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Who writes generated titles and branch names — the text-generation policy.
 *
 * ENGINE-SCOPED like the inbox rule beside it: a title generates once for
 * every window that can see the session, so the switch that governs it cannot
 * live in one browser's storage.
 *
 * FORWARDED UNVALIDATED, same reasoning as the inbox route: the engine holds
 * the driver enum and the model bound next to the schema that states them.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).textGenPolicy());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setTextGenPolicy({
        ...("titles" in body ? { titles: body.titles as boolean } : {}),
        ...("renameBranches" in body ? { renameBranches: body.renameBranches as boolean } : {}),
        ...("driver" in body ? { driver: body.driver as "claude" | "codex" } : {}),
        // `null` IS "back to the driver's default" and `undefined` is "leave
        // it alone" — presence, not truthiness.
        ...("model" in body ? { model: body.model as string | null } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
