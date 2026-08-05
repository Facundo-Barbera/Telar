import { promoteItemSubtask } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

// NFR-OW-15: "Agents have no promotion path, proposed or otherwise." This
// route is reached only by a human's own click in the packet-detail view —
// it is not, and must never become, an MCP tool. apps/web/lib/workspace-mcp.ts
// names exactly four tools and none of them is this one; INV-11's pinned
// inventory is what keeps that true under review rather than by convention.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; subtaskId: string }> },
) {
  const { id, subtaskId } = await params;
  const result = promoteItemSubtask(id, subtaskId);
  if (!result) return Response.json({ error: "Item or sub-task not found." }, { status: 404 });
  return Response.json(result);
}
