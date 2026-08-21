import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Program on disk. A project nobody has set up yet answers `exists: false`
 * with the path it would live at — NOT a 404, because "there is no Program yet"
 * is the ordinary first-run state and the editor has to render it in order to
 * be the thing that fixes it.
 */
export async function GET(request: Request) {
  try {
    const project = new URL(request.url).searchParams.get("project") ?? "";
    if (!project.trim()) {
      return Response.json(
        { error: { code: "invalid_request", message: "project is required — name the project whose Program you mean." } },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).loomProgram(project));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * PUT because a save replaces the one whole document — idempotent, last writer
 * wins. The parse warnings ride back on the same answer, so the editor never
 * shows a lint that belongs to a different version of the text.
 *
 * `markdown` may legitimately be empty (that is how a Program is cleared), so
 * it is checked for presence rather than for content.
 */
export async function PUT(request: Request) {
  try {
    const body = await requestObject(request);
    if (typeof body.markdown !== "string") {
      return Response.json(
        { error: { code: "invalid_request", message: "markdown is required — a save replaces the whole document, so send all of it." } },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).saveLoomProgram(requiredString(body.projectId, "projectId"), body.markdown));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
