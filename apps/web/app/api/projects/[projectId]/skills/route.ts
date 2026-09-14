import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import { ProviderDriverKind } from "@telar/engine-client";

/**
 * What a PROJECT's provider can be asked to do — the composer's `$` and `/`
 * menus on a canvas, before the session that would answer for itself exists.
 *
 * A PROXY AND NOTHING ELSE, exactly like the session twin next door: the
 * reading, the precedence and the cache all live in the engine
 * (`provider-skills.ts`). The one thing this adds is the pending driver, which
 * is a canvas's unsaved choice and therefore arrives as a query rather than
 * from a record.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const asked = ProviderDriverKind.safeParse(new URL(request.url).searchParams.get("driver"));
    const engine = await engineClient();
    return Response.json(await engine.projectSkills(projectId, asked.success ? asked.data : undefined));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
