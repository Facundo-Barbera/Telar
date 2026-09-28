import type { DataScienceBootstrap } from "@telar/engine-client";
import { engineClient, requestObject, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install uv, a Python, or Miniforge on this machine, as a job. */
export const POST = engineRoute(async (request: Request) => {
  const body = (await requestObject(request)) as unknown as DataScienceBootstrap;
  return Response.json(await (await engineClient()).dataScienceBootstrap(body));
});
