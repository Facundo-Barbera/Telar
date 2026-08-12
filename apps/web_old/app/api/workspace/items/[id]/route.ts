import { getPacketView, updateWorkspaceItem } from "@/lib/workspace-api";
import type { ItemPatch } from "@telar/core";

export const dynamic = "force-dynamic";

// NARROWER THAN THE STORE'S OWN PATCHABLE LIST, DELIBERATELY (fix-round
// correction — this list previously copied store.ts's full 8-key PATCHABLE
// verbatim, including `deadline` and `verdict`). Those two fields are named
// "5.4's to write" by store.ts's own ItemPatch comment and are deliberately
// absent from workspace-mcp.ts's update_item input shape for the same
// reason — nothing in THIS story reads either field back through a form or
// writes it from any component (queue-view.tsx/packet-view.tsx only ever
// RENDER item.deadline/item.verdict via DeadlineChip/VerdictChip). Before
// this narrowing there was no reachable HTTP path to either field anywhere
// in the app; this route had quietly opened one, untested and unused by any
// caller this story ships. Widen this list for `deadline` in 5.4, alongside
// whatever UI actually writes one — not before.
//
// `verdict` IS NOW SETTLED AND THE ANSWER IS NEVER. Story 5.8 gave the field
// its own endpoint — POST items/<id>/verdict — because a verdict a human sets
// is DURABLE: it goes through core's setItemVerdict, which raises
// `verdictOverride` so no later expert pass may re-flip it (CAP-9). The generic
// patch verb cannot do that; a verdict written through here would set the field
// with no flag, i.e. exactly the overwritable kind. Keep the two verbs apart.
const PATCHABLE_KEYS = new Set(["title", "lane", "project", "desk", "unplaced", "mirrored"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const view = getPacketView(id);
  if (!view) return Response.json({ error: "Item not found." }, { status: 404 });
  return Response.json(view);
}

// The store's own updateWorkspaceItem throws on any key outside ITS PATCHABLE
// list (AC9/NFR-OW-19) — this route's own filter exists only to turn a typo'd
// or premature key into an ordinary 400 rather than a 500 from an unguarded
// throw. It is a DELIBERATE SUBSET of the store's list, not a mirror of it —
// see PATCHABLE_KEYS above for which two fields are withheld and why. Nothing
// ties the two lists together automatically: workspace-store.test.ts tests
// store.ts's PATCHABLE, which it cannot see this file to compare against, so a
// human reviewing either list has to re-check this comment against the
// other's, not trust a test to catch drift.
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
