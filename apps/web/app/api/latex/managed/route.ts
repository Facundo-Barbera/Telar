import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Telar's own Tectonic: version, whether it is here, whether one is downloading. */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).managedTectonic());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** Fetch it. Idempotent — a second press joins the install already running. */
export async function POST() {
  try {
    return Response.json(await (await engineClient()).installManagedTectonic());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
