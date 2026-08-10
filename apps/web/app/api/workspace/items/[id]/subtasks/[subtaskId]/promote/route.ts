import { promoteItemSubtask } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

// NFR-OW-15: "Agents have no promotion path, proposed or otherwise." This
// route is reached only by a human's own click in the packet-detail view —
// it is not, and must never become, an MCP tool. apps/web/lib/workspace-mcp.ts
// names no promotion verb among its tools; INV-11's pinned inventory is what
// keeps that true under review rather than by convention.
//
// THE COUNT THAT USED TO BE IN THAT SENTENCE IS GONE ON PURPOSE: it said "exactly
// four tools" and went stale twice (5.5's weave_batch, 5.8's consult_expert)
// while the claim around it stayed true. A load-bearing comment should name the
// invariant, not a number that drifts under it.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; subtaskId: string }> },
) {
  const { id, subtaskId } = await params;
  const result = promoteItemSubtask(id, subtaskId);
  if (!result) return Response.json({ error: "Item or sub-task not found." }, { status: 404 });
  return Response.json(result);
}
