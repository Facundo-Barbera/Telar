import { getProject } from "@telar/core";
import { buildOverview } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// GET /api/projects/[name]/git — header + worktrees + branches + commits.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let entry;
  let manifest;
  try {
    ({ entry, manifest } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  try {
    const overview = await buildOverview(entry.root, name, manifest.baseBranch);
    return Response.json(overview);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
