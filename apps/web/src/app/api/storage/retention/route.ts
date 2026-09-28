import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The retention window, and what each candidate window would take — #542, #646.
 *
 * GET IS READ-ONLY AND DELETES NOTHING. It is the measurement the approved
 * design puts in front of the decision, against this person's own store: a
 * fixed default window is what destroys the install whose oldest session is a
 * week old, and their own three numbers are the defence.
 *
 * `?bytes=1` COSTS A SCAN of every qualifying row's text, where the counts
 * beside it are index ranges. Explicit, and never on a timer (#629).
 *
 * PUT SETS THE WINDOW and refuses one with nowhere to export to: the copy comes
 * before the delete, so a window without a destination would be a setting that
 * looked on and swept nothing.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const bytes = new URL(request.url).searchParams.get("bytes") === "1";
    return Response.json(await (await engineClient()).retention({ ...(bytes ? { bytes: true } : {}), signal: request.signal }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const patch = (await request.json()) as { idleAfterDays?: number | null; exportTo?: string | null };
    return Response.json(await (await engineClient()).setRetention(patch));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
