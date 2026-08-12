import {
  answerBlocked,
  getLoom,
  listAccounts,
  loadPolicy,
  ServersConfig,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Answers a loom parked in `blocked` (M10.4) and re-dispatches
// the verified build. The answer payload is `{ devCommand?, verifyCommand?,
// servers?, runbook? }` — at least one viability-making field must be present
// (answerBlocked rejects an empty/runbook-only answer). `verifyCommand` is the
// M11 strategy answer (a test/eval command whose exit code becomes the
// fail-closed verification gate — what the strategy-derived ask requests for a
// library/CLI/DS deliverable). The answerer identity (`by`) is bound
// server-side ("you"), NEVER read from the body — the moat requires a HUMAN
// by.
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
  let verifyCommand: string | undefined;
  let runbook: string | undefined;
  let servers: ServersConfig | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.devCommand === "string" && body.devCommand.trim()) {
      devCommand = body.devCommand.trim();
    }
    if (typeof body?.verifyCommand === "string" && body.verifyCommand.trim()) {
      verifyCommand = body.verifyCommand.trim();
    }
    if (typeof body?.runbook === "string" && body.runbook.trim()) {
      runbook = body.runbook.trim();
    }
    // A servers recipe, if given, must parse to a valid ServersConfig before we
    // hand it on.
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

  // Reject a non-viability-making answer up front — at least one of
  // devCommand/verifyCommand/servers (mirrors answerBlocked's own guard, which
  // returns false on an empty OR runbook-only payload: the runbook is optional
  // narrative isLaneViable never reads, so it can't resume the loom alone).
  if (!devCommand && !verifyCommand && !servers) {
    return Response.json(
      {
        ok: false,
        error:
          "Provide a dev command, a verification command, or a servers recipe — a runbook alone can't make the lane viable.",
      },
      { status: 400 },
    );
  }

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const ok = await answerBlocked(
      id,
      "you",
      { devCommand, verifyCommand, servers, runbook },
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
