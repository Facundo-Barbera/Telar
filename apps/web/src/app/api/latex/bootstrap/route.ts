import type { LatexBootstrap } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Install Tectonic or TinyTeX on this machine, as a job. */
export async function POST(request: Request) {
  try {
    const body = (await requestObject(request)) as unknown as LatexBootstrap;
    return Response.json(await (await engineClient()).latexBootstrap(body));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
