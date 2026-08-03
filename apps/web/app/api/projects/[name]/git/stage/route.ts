import { getProject } from "@telar/core";
import { setGitStaged } from "@/lib/server/git-workspace";

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json().catch(() => null) as { paths?: unknown; staged?: unknown } | null;
  try {
    const { entry } = getProject(name);
    await setGitStaged(entry.root, body?.paths, body?.staged !== false);
    return Response.json({ ok: true, message: body?.staged === false ? "Files unstaged." : "Files staged." });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
