import os from "node:os";
import { machineName } from "@/lib/remote/observe";
import { engineErrorResponse } from "@/lib/engine/engine-server";
import { engineCall, engineForward } from "@/lib/engine/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return engineForward(request, "/v2/hosts");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: { code: "invalid_request", message: "Request body must be a JSON object." } }, { status: 400 });
  }
  try {
    const answer = await engineCall("POST", "/v2/hosts", { ...body, deviceName: machineName() ?? os.hostname() });
    return Response.json(answer.body, { status: answer.status });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
