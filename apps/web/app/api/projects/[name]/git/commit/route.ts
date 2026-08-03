import { getProject } from "@telar/core";
import { commitGit } from "@/lib/server/git-workspace";

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json().catch(() => null) as { message?: unknown } | null;
  try {
    const { entry } = getProject(name);
    const detail = await commitGit(entry.root, body?.message);
    return Response.json({ ok: true, message: detail || "Commit created." });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
