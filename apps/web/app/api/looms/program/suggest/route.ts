import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * READS THE REPOSITORY AND PROPOSES A DRAFT — it never saves one. The answer is
 * markdown the user still has to accept through `PUT /api/looms/program`, plus
 * the findings that produced it, so nothing a model guessed becomes the standing
 * instruction without a hand on it.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).suggestLoomProgram(requiredString(body.projectId, "projectId")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
