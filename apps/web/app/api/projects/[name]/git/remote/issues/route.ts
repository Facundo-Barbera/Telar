import { getProject } from "@telar/core";
import { createIssue } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// POST /api/projects/[name]/git/remote/issues — HUMAN-triggered issue create.
// Body: { title: string (required, non-empty), body?: string }.
export async function POST(
  req: Request,
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

  const body = await req.json().catch(() => null);
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json(
      { error: "A non-empty title is required." },
      { status: 400 },
    );
  }
  const issueBody = typeof body.body === "string" ? body.body : "";

  try {
    return Response.json(
      await createIssue(entry.root, body.title.trim(), issueBody),
    );
  } catch {
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
