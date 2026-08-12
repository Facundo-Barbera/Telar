import { addItemSubtask } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json({ error: "A title is required." }, { status: 400 });
  }
  const updated = addItemSubtask(id, body.title);
  if (!updated) return Response.json({ error: "Item not found." }, { status: 404 });
  return Response.json({ item: updated });
}
