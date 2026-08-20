import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The search — deterministic, lexical, model-free (loops §10.2). An empty
 * query answers empty here rather than reaching the engine: nothing was asked.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") ?? "").trim();
    if (!query) return Response.json({ hits: [] });
    const subject = params.get("subject") ?? undefined;
    const limitRaw = params.get("limit");
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    return Response.json(
      await (await engineClient()).spoolSearch(query, {
        ...(subject ? { subject } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
