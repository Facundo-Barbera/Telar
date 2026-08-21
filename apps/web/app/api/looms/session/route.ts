import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE ORCHESTRATOR CONVERSATION, ENSURED — create-or-return, the same singleton
 * front door `/api/spool/master` is. "Open this project's orchestrator" and
 * "make one if there has never been one" are one request from the caller's
 * side; `created` says which happened so the cockpit can tell "resumed" from
 * "started" without a second read.
 *
 * NOT THE TICK, which is headless and keeps no transcript at all. This is the
 * room a human talks in, and it runs against the project's own root rather than
 * a worktree.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).ensureLoomSession(requiredString(body.projectId, "projectId")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
