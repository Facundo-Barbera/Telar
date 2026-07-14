import { getProject } from "@telar/core";
import { commentIssue, parsePositiveInt } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// POST /api/projects/[name]/git/remote/issues/[number]/comment — add a comment.
// Body: { body: string (required, non-empty) }.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string; number: string }> },
) {
  const { name, number } = await params;

  let entry;
  try {
    ({ entry } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  const n = parsePositiveInt(number);
  if (n === null) {
    return Response.json({ error: "Invalid issue number." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.body !== "string" || !body.body.trim()) {
    return Response.json(
      { error: "A non-empty comment body is required." },
      { status: 400 },
    );
  }

  try {
    return Response.json(await commentIssue(entry.root, n, body.body));
  } catch {
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
