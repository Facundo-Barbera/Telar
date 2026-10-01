import { engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async (request: Request) => {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  return Response.json(await (await engineClient()).worktreeSummary({ refresh }));
});
