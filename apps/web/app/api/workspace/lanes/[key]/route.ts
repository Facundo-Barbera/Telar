import { renameWorkspaceLane, retireWorkspaceLane } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

// renameLane can only ever rewrite `label` — the seed-lane-rename hazard is
// closed by making a lane's `key` permanently immutable once it exists (see
// store.ts's createLane/renameLane header). There is therefore no `key` field
// to accept here at all, not even to reject it.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.label !== "string" || !body.label.trim()) {
    return Response.json({ error: "A label is required." }, { status: 400 });
  }
  const lane = renameWorkspaceLane(key, body.label);
  if (!lane) return Response.json({ error: `No lane named "${key}" exists.` }, { status: 404 });
  return Response.json({ lane });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const result = retireWorkspaceLane(key);
  if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
  return Response.json({ ok: true });
}
