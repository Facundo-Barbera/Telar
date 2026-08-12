import { getProject } from "@telar/core";
import { runCleanup, type CleanupItem } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// POST /api/projects/[name]/git/cleanup — human-triggered, fail-closed removal.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let entry;
  let manifest;
  try {
    ({ entry, manifest } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) {
    return Response.json(
      { error: "Body must be { items: [...] }." },
      { status: 400 },
    );
  }

  const items: CleanupItem[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") {
      return Response.json({ error: "Each item must be an object." }, { status: 400 });
    }
    if (raw.kind === "worktree") {
      if (typeof raw.id !== "string" || !raw.id) {
        return Response.json({ error: "worktree item needs a string id." }, { status: 400 });
      }
      items.push({
        kind: "worktree",
        id: raw.id,
        force: raw.force === true,
        confirm: typeof raw.confirm === "string" ? raw.confirm : undefined,
        deleteMergedBranch: raw.deleteMergedBranch === true,
      });
    } else if (raw.kind === "branch") {
      if (typeof raw.name !== "string" || !raw.name) {
        return Response.json({ error: "branch item needs a string name." }, { status: 400 });
      }
      items.push({ kind: "branch", name: raw.name });
    } else {
      return Response.json(
        { error: `Unknown item kind: ${String(raw.kind)}.` },
        { status: 400 },
      );
    }
  }

  try {
    const results = await runCleanup(entry.root, name, items, manifest.baseBranch);
    return Response.json({ results });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
