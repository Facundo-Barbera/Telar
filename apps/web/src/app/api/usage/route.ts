import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Spend over time — the usage page's one read. The window rides through
 * verbatim; the engine owns the validation (a NaN window is refused there,
 * and re-checking here would be a second copy of the rule).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return Response.json(
      await (await engineClient()).usageReport({
        sinceMs: Number(url.searchParams.get("since")),
        untilMs: Number(url.searchParams.get("until")),
        ...(url.searchParams.get("resolution") === "hour" ? { resolution: "hour" as const } : {}),
        ...(url.searchParams.get("tz") ? { timeZone: url.searchParams.get("tz")! } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
