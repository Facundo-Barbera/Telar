import { approveCharter, getLoom, listAccounts, loadPolicy } from "@telar/core";

export const dynamic = "force-dynamic";

// Approves a drafted charter and dispatches the verified execution loop —
// structurally cannot accept a caller-supplied state/verdict: no body is
// read at all, only the id route param.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ error: "Loom not found." }, { status: 404 });
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const ok = await approveCharter(id, "you", { accounts, policy: loadPolicy() });
    return Response.json({ ok });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
