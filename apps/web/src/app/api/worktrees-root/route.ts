import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * Where session checkouts go — the Storage pane's one write.
 *
 * NO RESTART IS REPORTED because none is needed: the root decides where the
 * NEXT checkout lands, and every checkout already cut is addressed by the path
 * recorded on its session. Nothing is moved by a PUT here.
 *
 * `root: null` puts it back beside the store.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).worktreesRoot());
});

export const PUT = engineRoute(async (request: Request) => {
  const body = (await request.json()) as { root?: string | null };
  return Response.json(await (await engineClient()).setWorktreesRoot(body.root ?? null));
});
