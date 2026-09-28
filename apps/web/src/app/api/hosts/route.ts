import os from "node:os";
import { machineName } from "@/features/remote/server";
import { engineCall, engineForward, engineRoute, requestObject } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return engineForward(request, "/v2/hosts");
}

export const POST = engineRoute(async (request: Request) => {
  const answer = await engineCall("POST", "/v2/hosts", { ...(await requestObject(request)), deviceName: machineName() ?? os.hostname() });
  return Response.json(answer.body, { status: answer.status });
});
