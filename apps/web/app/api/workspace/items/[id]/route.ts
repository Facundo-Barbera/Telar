import { getPacketView, updateWorkspaceItem } from "@/lib/workspace-api";
import type { ItemPatch } from "@telar/core";

export const dynamic = "force-dynamic";

const PATCHABLE_KEYS = new Set(["title", "lane", "project", "desk", "unplaced", "mirrored", "deadline", "verdict"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const view = getPacketView(id);
  if (!view) return Response.json({ error: "Item not found." }, { status: 404 });
  return Response.json(view);
}

// The store's own updateWorkspaceItem throws on any key outside its PATCHABLE
// list (AC9/NFR-OW-19) — this route's own filter exists only to turn a typo'd
// key into an ordinary 400 rather than a 500 from an unguarded throw, and it
// is the same allow-list, kept in sync by workspace-store.test.ts's own AC9
// coverage rather than duplicated validation logic.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "A patch object is required." }, { status: 400 });
  }
  const unknown = Object.keys(body).filter((k) => !PATCHABLE_KEYS.has(k));
  if (unknown.length > 0) {
    return Response.json({ error: `Cannot patch ${unknown.join(", ")}.` }, { status: 400 });
  }
  try {
    const updated = updateWorkspaceItem(id, body as ItemPatch);
    if (!updated) return Response.json({ error: "Item not found." }, { status: 404 });
    return Response.json({ item: updated });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
