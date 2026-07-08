import { unregisterProject } from "@telar/core";

export const dynamic = "force-dynamic";

// Forget a repo — drops the registry entry, leaves the repo (and its telar.yaml) untouched.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return Response.json({ ok: unregisterProject(name) });
}
