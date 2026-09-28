import type { DataScienceBootstrap } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install uv, a Python, or Miniforge on this machine, as a job. */
export async function POST(request: Request) {
  try {
    const body = (await requestObject(request)) as unknown as DataScienceBootstrap;
    return Response.json(await (await engineClient()).dataScienceBootstrap(body));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
