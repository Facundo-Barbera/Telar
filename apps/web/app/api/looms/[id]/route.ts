import { getLoom } from "@telar/core";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loom = getLoom(id);
  if (!loom) return Response.json({ error: "Loom not found." }, { status: 404 });
  return Response.json({ loom });
}
