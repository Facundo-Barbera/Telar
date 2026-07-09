import { acceptLoom, getLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// Owner-only "close the loom" action (docs/loom-model.md §A) — structurally
// cannot be told who accepted or forced to override: no body is read at all,
// only the id route param. Acceptor identity is server-fixed ("you"). A
// normal accept requires the loom already be "ready"; acceptLoom throws
// otherwise, which we surface as 400. The override/cosign path (§M.2) is
// deliberately not exposed here — that's a future explicit-override UI.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ error: "Loom not found." }, { status: 404 });
  }

  try {
    const loom = acceptLoom(id, "you");
    return Response.json({ ok: true, loom });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
