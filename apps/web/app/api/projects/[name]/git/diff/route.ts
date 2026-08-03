import { getProject } from "@telar/core";
import type { GitDiffScope } from "@/lib/git-workspace-contract";
import { readGitDiff, safeGitRef, safeRepoPath } from "@/lib/server/git-workspace";

export const dynamic = "force-dynamic";
const SCOPES = new Set<GitDiffScope>(["working", "staged", "all", "compare"]);

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const search = new URL(request.url).searchParams;
  const rawScope = search.get("scope") ?? "all";
  if (!SCOPES.has(rawScope as GitDiffScope)) {
    return Response.json({ error: "Invalid diff scope." }, { status: 400 });
  }
  const rawPath = search.get("path");
  const filePath = rawPath == null ? undefined : safeRepoPath(rawPath) ?? undefined;
  if (rawPath != null && !filePath) return Response.json({ error: "Invalid path." }, { status: 400 });
  const rawBase = search.get("base");
  const base = rawBase == null ? undefined : safeGitRef(rawBase) ?? undefined;
  if (rawBase != null && !base) return Response.json({ error: "Invalid base branch." }, { status: 400 });
  try {
    const { entry } = getProject(name);
    return Response.json(await readGitDiff(entry.root, rawScope as GitDiffScope, filePath, base));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
