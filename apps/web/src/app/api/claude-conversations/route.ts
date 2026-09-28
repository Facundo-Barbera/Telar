import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The person's own Claude Code conversations, as `/resume`'s picker lists them
 * (#616).
 *
 * NOT UNDER A SESSION: the picker runs on a canvas, before the session it would
 * adopt into exists. `?instanceId=` says whose history — a configured login
 * keeps its own — and absent is the built-in slot, where a terminal `claude`
 * writes.
 *
 * A PROXY AND NOTHING ELSE. Resolving the login's config directory and hiding
 * the forks Telar has already adopted are the engine's job; a second opinion
 * here would be a second thing to keep in step with Claude Code's own layout.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const instanceId = new URL(request.url).searchParams.get("instanceId")?.trim();
    return Response.json(await (await engineClient()).claudeConversations(instanceId ? { instanceId } : {}));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
