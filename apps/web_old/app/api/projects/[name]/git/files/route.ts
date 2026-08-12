import { getProject } from "@telar/core";
import { buildFiles, safeRepoDir } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// GET /api/projects/[name]/git/files?path=<repo-relative dir> — one dir level.
export async function GET(
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

  const rawPath = new URL(req.url).searchParams.get("path");
  const rel = safeRepoDir(rawPath);
  if (rel === null) {
    return Response.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const files = await buildFiles(entry.root, rel);
    return Response.json(files);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A bad dir target is a client error; anything else is a git/fs failure.
    const status = msg.includes("not a directory") || msg.includes("escapes") ? 400 : 500;
    return Response.json({ error: msg }, { status });
  }
}
