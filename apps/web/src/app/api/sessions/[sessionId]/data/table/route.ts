import { engineClient, engineRoute, invalidRequest } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

/** A window of rows from a CSV, TSV or Parquet file, for the table view. */
export const GET = engineRoute(async (request: Request, context: Context) => {
  const { sessionId } = await context.params;
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) throw invalidRequest("A file path is required.");
  return Response.json(
    await (await engineClient()).sessionTable(sessionId, path, {
      offset: Number(url.searchParams.get("offset") ?? 0),
      limit: Number(url.searchParams.get("limit") ?? 200),
      ...(url.searchParams.get("sort") ? { sort: url.searchParams.get("sort")! } : {}),
      ...(url.searchParams.get("desc") === "1" ? { desc: true } : {}),
    }),
  );
});
