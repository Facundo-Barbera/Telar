import { engineClient, engineRoute } from "@/platform/engine/server";

/** Forget one standing instruction — issue #543. The session it pointed at is
 *  untouched; only the clock stops. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ scheduleId: string }> };

export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { scheduleId } = await context.params;
  return Response.json(await (await engineClient()).deleteSchedule(scheduleId));
});
