import { getProject } from "@telar/core";
import { checkoutGitBranch } from "@/lib/server/git-workspace";

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json().catch(() => null) as { name?: unknown; create?: unknown } | null;
  try {
    const { entry } = getProject(name);
    const branch = await checkoutGitBranch(entry.root, body?.name, body?.create === true);
    return Response.json({ ok: true, message: `Checked out ${branch}.` });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
