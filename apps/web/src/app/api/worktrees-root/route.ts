import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

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

export async function GET() {
  try {
    return Response.json(await (await engineClient()).worktreesRoot());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { root?: string | null };
    return Response.json(await (await engineClient()).setWorktreesRoot(body.root ?? null));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
