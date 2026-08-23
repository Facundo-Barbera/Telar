import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `POST` starts a night and returns at once with the plan; `GET` reads progress.
 *
 * THE SPLIT IS NOT STYLE — it is what a live run forced. Awaiting the whole
 * thing here returned "engine is unreachable" after five minutes while the
 * daemon carried on and finished every job, which made a working system look
 * broken. The record is on disk after each job, so `GET` is always current and
 * needs no streaming.
 */

export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolNight());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await requestObject(request).catch(() => ({}) as Record<string, unknown>);
    return Response.json(
      await (await engineClient()).startSpoolNight({
        ...(typeof body.maxJobs === "number" ? { maxJobs: body.maxJobs } : {}),
        ...(typeof body.maxCostUsd === "number" ? { maxCostUsd: body.maxCostUsd } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
