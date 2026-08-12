import { getProject } from "@telar/core";
import { pushGit } from "@/lib/server/git-workspace";

export async function POST(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const { entry } = getProject(name);
    const detail = await pushGit(entry.root);
    return Response.json({ ok: true, message: detail || "Branch pushed." });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
