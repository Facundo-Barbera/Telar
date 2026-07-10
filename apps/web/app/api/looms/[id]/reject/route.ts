import { getLoom, listAccounts, loadPolicy, rejectLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// docs/loom-model.md §A — REJECT sends a verified (`ready`) or paused
// (`blocked`) loom back to work with feedback; it re-enters the verified loop
// and never reaches `done`. The rejecter identity (`by`) is bound server-side
// ("you"), NEVER read from the request body — only `feedback` is taken from
// the caller.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }

  let feedback: unknown;
  try {
    feedback = (await req.json())?.feedback;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof feedback !== "string" || !feedback.trim()) {
    return Response.json({ ok: false, error: "A non-empty `feedback` is required." }, { status: 400 });
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const loom = await rejectLoom(id, feedback, "you", { accounts, policy: loadPolicy() });
    return Response.json({ ok: true, loom });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
