import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; promptId: string }> };

/** Title, text, reason. The engine refuses a patch that names `author` —
 *  provenance is stamped once, so a draft an agent wrote stays marked as one
 *  however far you edit it before sending. */
export const PATCH = engineRoute(async (request: Request, context: Context) => {
  const { projectId, promptId } = await context.params;
  const patch = (await request.json()) as { title?: string; text?: string; reason?: string };
  return Response.json(await (await engineClient()).updateProjectPrompt(projectId, promptId, patch));
});

/** The ordinary end of a prepared prompt: it was sent, or discarded.
 *  `deleted: false` means it was already gone — never an error, because two
 *  windows on one shelf is the expected case rather than a race to report. */
export const DELETE = engineRoute(async (_request: Request, context: Context) => {
  const { projectId, promptId } = await context.params;
  return Response.json(await (await engineClient()).deleteProjectPrompt(projectId, promptId));
});
