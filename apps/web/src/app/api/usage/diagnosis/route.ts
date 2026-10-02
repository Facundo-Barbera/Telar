import { requestObject, engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => Response.json(await (await engineClient()).usageDiagnosis()));

export const POST = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  return Response.json(
    await (await engineClient()).startUsageDiagnosis({
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
    }),
  );
});
