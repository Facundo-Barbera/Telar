import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Telar's own Tectonic: version, whether it is here, whether one is downloading. */
export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).managedTectonic());
});

/** Fetch it. Idempotent — a second press joins the install already running. */
export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).installManagedTectonic());
});
