import { getProject } from "@telar/core";
import { readGitWorkspaceStatus } from "@/lib/server/git-workspace";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const { entry } = getProject(name);
    return Response.json(await readGitWorkspaceStatus(entry.root));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
