import { getUltraManifest } from "@telar/core";

export const dynamic = "force-dynamic";

// Manifest + state + terminal result (doc §5's `/api/ultra/[id] GET`). Same
// self-healing read as the list route — a `running` manifest with no live
// task in this process reconciles to `stopped` here too.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getUltraManifest(id);
  if (!run) return Response.json({ error: "Ultra run not found." }, { status: 404 });
  return Response.json({ run });
}
