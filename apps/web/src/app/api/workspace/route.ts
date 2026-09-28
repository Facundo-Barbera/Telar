import { requestObject, engineClient, engineRoute } from "@/platform/engine/server";
import type { WorkspaceConfig } from "@telar/engine-client";

/**
 * This Mac's worktree defaults — the `machine` layer of `protocol/workspace.ts`.
 *
 * A WHOLE-LAYER PUT, forwarded unvalidated: the engine parses it against
 * `WorkspaceConfig`, and a second copy of that check here could only disagree.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).machineWorkspace());
});

export const PUT = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  return Response.json(await (await engineClient()).setMachineWorkspace((body.machine ?? {}) as WorkspaceConfig));
});
