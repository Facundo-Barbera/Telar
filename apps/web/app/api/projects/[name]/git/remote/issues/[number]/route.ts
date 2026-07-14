import { getProject } from "@telar/core";
import { fetchIssueDetail, parsePositiveInt } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// GET /api/projects/[name]/git/remote/issues/[number] — issue detail.
// Auth-gated: never 500s the panel — returns { connected: false, reason }.
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
    return Response.json({ error: "Invalid issue number." }, { status: 400 });
  }

  try {
    return Response.json(await fetchIssueDetail(entry.root, n));
  } catch {
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
