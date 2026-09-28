import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { WorkspaceConfig } from "@telar/engine-client";

/**
 * This Mac's worktree defaults — the `machine` layer of `protocol/workspace.ts`.
 *
 * A WHOLE-LAYER PUT, forwarded unvalidated: the engine parses it against
 * `WorkspaceConfig`, and a second copy of that check here could only disagree.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).machineWorkspace());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).setMachineWorkspace((body.machine ?? {}) as WorkspaceConfig));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
