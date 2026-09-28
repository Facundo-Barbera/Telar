import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async (request: Request) => {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return Response.json(await (await engineClient()).latexToolchain(fresh));
});
