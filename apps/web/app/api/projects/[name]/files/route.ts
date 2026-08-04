import { getProject } from "@telar/core";
import { searchProjectFiles } from "@/lib/project-files";

export const dynamic = "force-dynamic";

// Ranked file candidates for the composer's `@` mention menu. Repo-relative
// paths only — see lib/project-files.ts for the ranking and for why the path
// that comes back on the next turn is re-validated rather than trusted.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let root: string;
  try {
    root = getProject(name).manifest.root;
  } catch {
    return Response.json({ error: `Unknown project "${name}".` }, { status: 404 });
  }

  const query = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ files: searchProjectFiles(root, query) });
}
