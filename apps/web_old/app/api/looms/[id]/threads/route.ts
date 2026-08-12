import { listChildLooms } from "@telar/core";

export const dynamic = "force-dynamic";

// Child Looms of a woven root (docs/loom-orchestrator.md §4) — a fresh weave
// or a non-weaving loom id legitimately has zero children, so this never
// 404s; the UI treats `{ threads: [] }` as an empty-threads state, not an
// error.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return Response.json({ threads: listChildLooms(id) });
}
