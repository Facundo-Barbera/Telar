import { getLoom, listAccounts, loadPolicy, resumeLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// docs/loom-model.md §A — RESUME is a no-feedback retry: send a dead-ended
// (`failed`), unverified (`needs-review`), or paused (`blocked`) loom back into
// the SAME verified loop with no new directive; resumeLoom enforces the state
// guard. Like accept/steer/reject it takes NO body — no feedback, only the id
// route param — and re-enters dispatchExecution + RE-VERIFIES, so it can only
// land back at `ready`, never jump to `done` (the moat holds).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const loom = resumeLoom(id, { accounts, policy: loadPolicy() });
    return Response.json({ ok: true, loom });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
