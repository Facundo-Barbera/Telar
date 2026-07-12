import { getLoom, listAccounts, loadPolicy, rejectLoom } from "@telar/core";

export const dynamic = "force-dynamic";

// Rejects an env-review proposal → the loom lands honest `needs-review` (the
// same terminal as flag-off). rejectLoom enforces the state guard. The rejecter
// identity (`by`) is bound server-side ("you"), never read from the body; an
// optional `feedback` note is taken from the caller, defaulting to a plain
// reason so the human need not type one.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }

  let feedback = "Environment proposal rejected.";
  try {
    const note = (await req.json().catch(() => ({})))?.feedback;
    if (typeof note === "string" && note.trim()) feedback = note;
  } catch {
    // Body is optional; fall back to the default reason.
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
