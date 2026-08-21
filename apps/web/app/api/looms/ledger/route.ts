import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the loom did, in its own words. `limit` is how far back to read; absent
 *  is as many as the engine keeps. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const project = params.get("project") ?? "";
    if (!project.trim()) {
      return Response.json(
        { error: { code: "invalid_request", message: "project is required — name the project whose ledger you mean." } },
        { status: 400 },
      );
    }
    const limitRaw = params.get("limit");
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    return Response.json(
      await (await engineClient()).loomLedger(project, limit !== undefined && Number.isFinite(limit) ? limit : undefined),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
