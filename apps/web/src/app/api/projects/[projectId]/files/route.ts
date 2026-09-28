import { engineClient, engineRoute, invalidRequest } from "@/platform/engine/server";

/**
 * A project's files, for the Files tree.
 *
 * `?path=` NARROWS TO ONE FILE'S TEXT — the same split as `/diff`, and for the
 * same reason: the tree asks for every path once, and a viewer asks for one file
 * at a time. The path is fenced inside the project root by the ENGINE, not here;
 * a check that only ran on this hop would not protect an in-process caller.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  const engine = await engineClient();
  if (target) return Response.json(await engine.projectFile(projectId, target));
  return Response.json(await engine.projectFiles(projectId));
});

/**
 * Save an edited file.
 *
 * The body carries `expectedSha256` — the hash the editor read — and the ENGINE
 * decides whether disk still matches. A refusal comes back 200 with
 * `written: false`; this hop adds nothing but the parameter check, because a
 * precondition enforced here would not protect an in-process caller.
 */
export const PUT = engineRoute(async (request: Request, context: Context) => {
  const { projectId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  if (!target) throw invalidRequest("a file path is required");
  const body = (await request.json()) as { text?: unknown; expectedSha256?: unknown };
  if (typeof body.text !== "string" || typeof body.expectedSha256 !== "string") {
    throw invalidRequest("text and expectedSha256 are required");
  }
  const engine = await engineClient();
  return Response.json(await engine.writeProjectFile(projectId, target, body.text, body.expectedSha256));
});
