import { getProject } from "@telar/core";
import { buildRemote } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// GET /api/projects/[name]/git/remote — `gh` CLI, auth-gated.
// Never 500s on a missing/unauthed gh — returns { connected: false, reason }.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let entry;
  try {
    ({ entry } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  try {
    const remote = await buildRemote(entry.root, name);
    return Response.json(remote);
  } catch {
    // buildRemote is defensive, but never leak a 500 for the remote panel.
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
