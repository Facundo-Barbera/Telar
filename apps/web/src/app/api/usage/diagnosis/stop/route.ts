import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = engineRoute(async () => Response.json(await (await engineClient()).stopUsageDiagnosis()));
