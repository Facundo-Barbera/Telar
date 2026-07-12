import {
  answerBlocked,
  getLoom,
  listAccounts,
  loadPolicy,
  ServersConfig,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Answers a loom parked in `blocked` (M10.4 laneEscalation) and re-dispatches
// the verified build. The answer payload is `{ devCommand?, servers?, runbook? }`
// — at least one must be present (answerBlocked rejects an empty answer). The
// answerer identity (`by`) is bound server-side ("you"), NEVER read from the
// body — the moat requires a HUMAN by, exactly like env/approve.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loom = getLoom(id);
  if (!loom) {
    return Response.json({ ok: false, error: "Loom not found." }, { status: 404 });
  }
  if (loom.state !== "blocked") {
    return Response.json(
      { ok: false, error: "Loom is not blocked." },
      { status: 400 },
    );
  }

  let devCommand: string | undefined;
  let runbook: string | undefined;
  let servers: ServersConfig | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.devCommand === "string" && body.devCommand.trim()) {
      devCommand = body.devCommand.trim();
    }
    if (typeof body?.runbook === "string" && body.runbook.trim()) {
      runbook = body.runbook.trim();
    }
    // A servers recipe, if given, must parse to a valid ServersConfig before we
    // hand it on (mirrors env/approve's Steer validation).
    if (body?.servers !== undefined && body.servers !== null) {
      const parsed = ServersConfig.safeParse(body.servers);
      if (!parsed.success) {
        return Response.json(
          { ok: false, error: "Servers recipe is not a valid ServersConfig." },
          { status: 400 },
        );
      }
      servers = parsed.data;
    }
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // Reject an empty answer up front — at least one of devCommand/servers/runbook
  // (mirrors answerBlocked's own guard, which returns false on an empty payload).
  if (!devCommand && !runbook && !servers) {
    return Response.json(
      { ok: false, error: "Provide a dev command, a servers recipe, or a runbook." },
      { status: 400 },
    );
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const ok = await answerBlocked(
      id,
      "you",
      { devCommand, servers, runbook },
      { accounts, policy: loadPolicy() },
    );
    return Response.json({ ok });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
