import { getProject } from "@telar/core";
import { fetchPRDetail, parsePositiveInt } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// GET /api/projects/[name]/git/remote/prs/[number] — PR detail (metadata +
// reviews + checks + capped file diffs). Auth-gated: never 500s the panel.
export async function GET(
  _req: Request,
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
    return Response.json({ error: "Invalid PR number." }, { status: 400 });
  }

  try {
    return Response.json(await fetchPRDetail(entry.root, n));
  } catch {
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
