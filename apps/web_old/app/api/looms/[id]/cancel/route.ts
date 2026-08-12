import { cancelLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// Aborts an in-flight loom — only works while its process is alive in this server.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return Response.json({ ok: cancelLoom(id) });
}
