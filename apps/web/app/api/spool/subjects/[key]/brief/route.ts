import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ key: string }> };

/**
 * THE RE-ENTRY BRIEF — `docs/spool-loops.md` §13.2. One subject's room,
 * opened: where you left off, what moved, what's open, what's next, cited.
 * Same `today` convention as `/api/spool/lobby`.
 */
export async function GET(request: Request, context: Context) {
  try {
    const { key } = await context.params;
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    return Response.json(await (await engineClient()).spoolSubjectBrief(key, today ?? undefined));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
