import {
  approveEnv,
  getLoom,
  listAccounts,
  loadPolicy,
  ServersConfig,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Accepts an env-review proposal and re-dispatches the verified build. Unlike
// charter/approve, this DOES read a body: an optional edited `config` is the
// Steer path (the human corrected the proposal); absent, `approveEnv` accepts
// `loom.proposedServers` as-is. The approver identity (`by`) is bound
// server-side ("you"), NEVER read from the body — the moat requires a human by.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }

  // Body is optional (Accept-as-is sends none). Only a present `config` is a
  // Steer, and it must parse to a valid ServersConfig before we hand it on.
  let config: ServersConfig | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.config !== undefined && body.config !== null) {
      const parsed = ServersConfig.safeParse(body.config);
      if (!parsed.success) {
        return Response.json(
          { ok: false, error: "Edited config is not a valid ServersConfig." },
          { status: 400 },
        );
      }
      config = parsed.data;
    }
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const ok = await approveEnv(id, "you", config, { accounts, policy: loadPolicy() });
    return Response.json({ ok });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
