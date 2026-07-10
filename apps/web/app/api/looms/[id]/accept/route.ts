import { acceptLoom, getLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// Owner-only "close the loom" action (docs/loom-model.md §A) — structurally
// cannot be told who accepted or forced to override: no body is read at all,
// only the id route param. Acceptor identity is server-fixed ("you").
// acceptLoom auto-detects the accept KIND from the loom's state: a clean
// accept from `ready`, or (P5) an AUDITED OVERRIDE from `needs-review`/
// `blocked` (recorded override:true — the server-derived `by` is the human
// touch, so no separate cosign UI is needed for those states). Any other
// non-ready state needs the explicit override+cosign path, which acceptLoom
// throws for here (surfaced as 400) — that remains a future explicit-override UI.
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
