import { acceptLoom, getLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// Owner-only "close the loom" action (docs/loom-model.md §A). Acceptor
// identity is server-fixed ("you"). The route forwards an optional
// `{override, missing}` body to acceptLoom: a clean accept of `ready` sends
// none; an AUDITED OVERRIDE of any other non-`done` state (`queued`,
// `needs-review`, `blocked`, `failed`, …) REQUIRES `{override:true, missing}`
// naming what's missing (L3, contract v0.8) — acceptLoom rejects a bare
// override with a thrown error, surfaced below as a 400. Only an already-
// `done` loom or a child loom (parentLoomId set — consumed by the weave
// rollup, never human-accepted) is also rejected this way.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ error: "Loom not found." }, { status: 404 });
  }

  // Body is optional: a clean accept of `ready` sends none; an override sends
  // { override: true, missing }. Tolerate an empty/absent body.
  let body: { override?: boolean; missing?: string } = {};
  try {
    body = (await req.json()) as { override?: boolean; missing?: string };
  } catch {
    body = {};
  }

  try {
    const loom = acceptLoom(id, "you", {
      override: body.override,
      missing: body.missing,
    });
    return Response.json({ ok: true, loom });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
