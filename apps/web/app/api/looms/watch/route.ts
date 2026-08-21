import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Start or stop the sentinel. ONE ROUTE WITH A FLAG rather than two verbs: the
 * watch is a single slot with two values, and separate start/stop endpoints let
 * a surface believe it last called the other one.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    if (typeof body.running !== "boolean") {
      return Response.json(
        { error: { code: "invalid_request", message: "running must be true to start the watch or false to stop it." } },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).setLoomWatch(requiredString(body.projectId, "projectId"), body.running));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
