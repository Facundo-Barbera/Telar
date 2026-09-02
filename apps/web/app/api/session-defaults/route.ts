import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { EnvMode } from "@telar/engine-client";

/**
 * What a new session is built with when nobody said — today, the workspace:
 * the project's own checkout, or a worktree of its own.
 *
 * ENVIRONMENT-SCOPED, like the inbox rule beside it and for the same reason:
 * the desktop shell and a browser tab on one engine must agree about what "new
 * session" means, or the composer's pre-selected answer looks like a bug.
 *
 * FORWARDED UNVALIDATED, also like the inbox rule: the set of legal modes lives
 * next to the schema in the engine, and a second copy here could disagree.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).sessionDefaults());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setSessionDefaults({
        ...("envMode" in body ? { envMode: body.envMode as EnvMode } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
