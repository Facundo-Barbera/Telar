import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The classified backlog — one entry per item the loom has looked at, with the
 *  classification and the reason it gave. */
export async function GET(request: Request) {
  try {
    const project = new URL(request.url).searchParams.get("project") ?? "";
    if (!project.trim()) {
      return Response.json(
        { error: { code: "invalid_request", message: "project is required — name the project whose triage you mean." } },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).loomTriage(project));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
