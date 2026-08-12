import { toggleItemSubtask } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; subtaskId: string }> },
) {
  const { id, subtaskId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.done !== "boolean") {
    return Response.json({ error: "`done` (boolean) is required." }, { status: 400 });
  }
  const updated = toggleItemSubtask(id, subtaskId, body.done);
  if (!updated) return Response.json({ error: "Item or sub-task not found." }, { status: 404 });
  return Response.json({ item: updated });
}
