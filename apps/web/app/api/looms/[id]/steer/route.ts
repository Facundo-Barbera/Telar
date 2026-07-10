import { getLoom, listAccounts, loadPolicy, steerLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// docs/loom-model.md §A — from `ready` the owner may STEER: add a directive
// and the loom re-enters the verified loop (never jumps to `done`). The
// acceptor/steerer identity (`by`) is bound server-side ("you"), NEVER read
// from the request body — only `directive` is taken from the caller.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }

  let directive: unknown;
  try {
    directive = (await req.json())?.directive;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof directive !== "string" || !directive.trim()) {
    return Response.json({ ok: false, error: "A non-empty `directive` is required." }, { status: 400 });
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const loom = await steerLoom(id, directive, "you", { accounts, policy: loadPolicy() });
    return Response.json({ ok: true, loom });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
