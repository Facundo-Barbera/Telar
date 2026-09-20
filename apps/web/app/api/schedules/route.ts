import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { ScheduleRule } from "@telar/engine-client";

/**
 * THE STANDING INSTRUCTIONS ON THIS INSTALL — issue #543.
 *
 * READ-ONLY ON GET, and cheap: one indexed table read, no scan. `?sessionId=`
 * narrows it to one conversation's rows.
 *
 * POST CREATES OR REPLACES, and deliberately cannot name `nextRunAt` — the
 * engine computes the first one from the rule and the zone. A caller that could
 * name it could aim a row at the past, which the grace rule would then skip for
 * ever.
 *
 * THERE IS NO "RUN NOW" DOOR, here or on the engine. It would be a second way
 * to start a turn carrying none of the sweep's re-aiming: pressing it twice
 * gives two turns and a `nextRunAt` that means nothing. Sending the prompt is
 * what the composer is for.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;
    return Response.json(await (await engineClient()).schedules(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean };
    return Response.json(await (await engineClient()).putSchedule(input));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
