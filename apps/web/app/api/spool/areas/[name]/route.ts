import type { SpoolSubjectPermits } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ name: string }> };

/**
 * STATE A CEILING ON AN AREA — or withdraw one with `null`, a corrected
 * statement rather than a deletion. The ceiling CLAMPS every member subject's
 * effective permit down, never up; the levels reuse the subject permits
 * vocabulary, guarded here in the same words the engine would refuse with.
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { name } = await context.params;
    const body = await requestObject(request);
    const ceiling = body.ceiling;
    if (ceiling !== null && ceiling !== "read" && ceiling !== "draft" && ceiling !== "propose") {
      return Response.json(
        { error: `ceiling must be "read", "draft", "propose" or null — got ${JSON.stringify(ceiling)}.` },
        { status: 400 },
      );
    }
    return Response.json(
      await (await engineClient()).setSpoolAreaCeiling(name, ceiling as SpoolSubjectPermits | null),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
